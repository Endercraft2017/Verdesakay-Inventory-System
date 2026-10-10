/* Main application controller: auth, routing, ECOUNT-style chrome wiring.
   The navigation tree lives in nav-config.js (global NAV / ROUTE_NAMES). */
const App = (() => {
  let me = null;
  let departments = [];
  const routes = {}; // name -> render(viewEl, filter)

  // Active chrome selection (which primary/subtab the tree+subnav reflect).
  let activePrimaryId = null;
  let activeSubtabId = null;
  let renderedLocation = null;
  let suppressHash = false; // guard so programmatic hash changes don't re-navigate

  function register(name, renderFn) { routes[name] = renderFn; }

  function getMe() { return me; }
  function getDepartments() { return departments; }
  function isAdmin() { return me && me.role === 'admin'; }
  function hasPermission(key) { return me && Array.isArray(me.permissions) && me.permissions.includes(key); }
  /** SaaS feature-module entitlement for this workspace (see src/modules.ts). When the
      list is absent — self-hosted, or the moment before /auth/me resolves — treat every
      module as on so nothing is hidden. */
  function hasModule(key) { return !me || !Array.isArray(me.modules) || me.modules.includes(key); }

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
    if (window.ChatWS) ChatWS.disconnect();
    if (window.SyncStatus) SyncStatus.stop();
    appScreen().classList.add('hidden');
    loginScreen().classList.remove('hidden');
    document.getElementById('login-password').value = '';
  }

  /** `departmentsReq`: the department list, already requested by the caller (boot starts it
      alongside /auth/me so a page load waits one round trip less). */
  async function showApp(departmentsReq) {
    loginScreen().classList.add('hidden');
    appScreen().classList.remove('hidden');

    document.getElementById('me-name').textContent = me.full_name;
    document.getElementById('me-role').textContent = me.role_label || me.role;
    document.getElementById('me-dept').textContent = me.department_name || 'No dept';
    document.getElementById('me-avatar').textContent = UI.initials(me.full_name);

    try { departments = await (departmentsReq || API.get('/users/departments/list')); } catch { departments = []; }

    renderPrimaryNav(); // (re)build chrome; honours admin-only visibility
    // The AI Assistant bubble is a per-tenant feature module.
    const aiFab = document.getElementById('ai-fab');
    if (aiFab) aiFab.classList.toggle('hidden', !hasModule('ai'));
    showWorkspaceBanner();

    refreshUnread();
    // Installed PCs only: the sync status pill (lib/sync-status.js hides itself elsewhere).
    if (window.SyncStatus) SyncStatus.start();
    if (App._unreadTimer) clearInterval(App._unreadTimer);
    // Live push (ChatWS) keeps the badge current when connected; this poll is the
    // fallback for whenever it isn't (reconnecting, blocked by a proxy, ...).
    App._unreadTimer = setInterval(() => { if (!(window.ChatWS && ChatWS.connected)) refreshUnread(); }, 20000);
    if (window.ChatWS) {
      ChatWS.off('message:new', refreshUnread);
      ChatWS.off('message:deleted', refreshUnread);
      ChatWS.on('message:new', refreshUnread);
      ChatWS.on('message:deleted', refreshUnread);
      ChatWS.connect();
    }

    const parsed = parseHash();
    const start = routes[parsed.route] ? parsed.route : 'dashboard';
    navigate(start, parsed.route === start ? parsed.filter : undefined);
  }

  async function showWorkspaceBanner() {
    let t;
    try { t = await API.get('/tenant'); } catch { return; }
    document.getElementById('ws-banner')?.remove();
    let msg = '', tone = 'warn';
    if (t.read_only) { msg = `${t.name} is past due — the workspace is read-only until billing is resolved.`; tone = 'danger'; }
    else if (t.status === 'suspended') { msg = `${t.name} is suspended.`; tone = 'danger'; }
    else if (t.trial_days_left != null && t.trial_days_left <= 14) {
      msg = t.trial_days_left <= 0 ? `${t.name}'s trial has ended.`
        : `${t.name} — trial: ${t.trial_days_left} day${t.trial_days_left === 1 ? '' : 's'} left.`;
    }
    if (!msg) return;
    const bar = document.createElement('div');
    bar.id = 'ws-banner';
    bar.style.cssText = `padding:6px 14px;font-size:13px;text-align:center;color:#fff;`
      + `background:${tone === 'danger' ? 'var(--danger,#d64545)' : 'var(--warn,#b8860b)'}`;
    bar.textContent = msg;
    appScreen().prepend(bar);
  }

  /* Notification history (GET /api/notifications — release reports, parts, QA holds …): the
     rail bell's badge counts unread; the panel lists them, opens the record (link.route) and
     marks it read. */
  async function refreshNotificationBadge() {
    try {
      const { count } = await API.get('/notifications/unread-count');
      const b = document.getElementById('notif-badge');
      if (b) { b.textContent = count; b.classList.toggle('hidden', !count); }
    } catch { /* ignore */ }
  }
  async function openNotifications() {
    let data;
    try { data = await API.get('/notifications?limit=50'); } catch (e) { UI.toast(e.message, 'error'); return; }
    const items = data.items || [];
    const m = UI.modal({
      title: 'Notifications',
      size: 'lg',
      cancelText: 'Close',
      confirmText: data.unread ? 'Mark all read' : null,
      bodyHTML: items.length ? `<table><tbody>${items.map((n) => `
        <tr class="${n.link ? 'clickable' : ''}" data-n="${n.id}">
          <td style="width:8px">${n.read_at ? '' : '<span class="badge-pill warn" title="Unread">new</span>'}</td>
          <td><strong>${UI.esc(n.title)}</strong>${n.body ? `<div class="muted">${UI.esc(n.body)}</div>` : ''}</td>
          <td class="muted" style="white-space:nowrap">${UI.esc(UI.fmtDate ? UI.fmtDate(n.created_at + 'Z') : n.created_at)}</td>
        </tr>`).join('')}</tbody></table>`
        : UI.emptyState({ icon: 'bell', title: 'No notifications', hint: 'Release reports, parts and QA holds that concern you appear here.' }),
      onOpen: (ov) => {
        ov.querySelectorAll('tr[data-n]').forEach((tr) => tr.onclick = async () => {
          const n = items.find((x) => String(x.id) === tr.dataset.n);
          if (!n.read_at) { try { await API.post('/notifications/' + n.id + '/read', {}); } catch { /* ignore */ } }
          refreshNotificationBadge();
          if (n.link && routes[n.link.route]) { m.close(); navigate(n.link.route, n.link.params || undefined); }
        });
      },
      onConfirm: async () => {
        await API.post('/notifications/read-all', {});
        refreshNotificationBadge();
      },
    });
  }

  /** Rail badges: messages, notifications and (admins) open bug reports — fetched together,
      not one after another, so a refresh costs one round trip. */
  async function refreshUnread() {
    const setBadge = (id, count) => {
      const badge = document.getElementById(id);
      if (badge) {
        badge.textContent = count;
        badge.classList.toggle('hidden', !count);
      }
    };
    await Promise.all([
      API.get('/messages/unread-count').then(({ count }) => setBadge('msg-badge', count)).catch(() => {}),
      refreshNotificationBadge(),
      hasPermission('users.manage')
        ? API.get('/bug-reports/open-count').then(({ count }) => setBadge('bug-badge', count)).catch(() => {})
        : null,
    ]);
  }

  /* ---------- Nav-config helpers ---------- */

  /** Visible primaries — filtered by adminOnly (legacy), requiredPermission, requiredModule, and
      dropped when none of their subtabs is visible (e.g. Inventory for an HR-only account). */
  function visiblePrimaries() {
    return NAV.filter((p) => {
      if (p.adminOnly && !isAdmin()) return false;
      if (p.requiredPermission && !hasPermission(p.requiredPermission)) return false;
      if (p.requiredModule && !hasModule(p.requiredModule)) return false;
      return visibleSubtabs(p).length > 0;
    });
  }

  /** Visible subtabs for a primary — filtered by requiredPermission and requiredModule. */
  function visibleSubtabs(primary) {
    return (primary.subtabs || []).filter((s) =>
      (!s.requiredPermission || hasPermission(s.requiredPermission)) &&
      (!s.requiredModule || hasModule(s.requiredModule)));
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
          } else if (filtersEqual(leaf.filter, filter) || (leaf.filter && Object.keys(leaf.filter).every(key => String(leaf.filter[key]) === String(filter[key])))) {
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
    const subs = visibleSubtabs(primary);
    el.innerHTML = subs.map((s) =>
      `<button class="subtab ${s.id === activeSubtabId ? 'active' : ''}" data-subtab="${s.id}">${UI.esc(s.label)}</button>`
    ).join('');
    el.querySelectorAll('[data-subtab]').forEach((b) =>
      b.addEventListener('click', () => {
        const sub = subs.find((s) => s.id === b.dataset.subtab);
        const leaf = sub && sub.tree[0];
        if (leaf) navigate(leaf.route, leaf.filter);
      }));
  }

  function renderTree(primary, subtab, activeRoute, activeFilter) {
    const el = document.getElementById('tree-nav');
    if (!el) return;
    if (!primary || !subtab) { el.innerHTML = ''; return; }
    const leaves = subtab.tree.map((leaf) => {
      const on = leaf.route === activeRoute && (filtersEqual(leaf.filter, activeFilter) || (leaf.filter && Object.keys(leaf.filter).every(key => String(leaf.filter[key]) === String((activeFilter || {})[key]))));
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
    const dialogs = [...document.querySelectorAll('.modal-overlay')].reverse();
    const savingDialog = dialogs.find(dialog => dialog.__whenSaved);
    if (savingDialog) { savingDialog.__whenSaved.then(() => navigate(name, filter)); return; }
    if (dialogs.some(dialog => dialog.__canDismiss && !dialog.__canDismiss())) {
      if (renderedLocation) history.replaceState(null, '', '#' + hashFor(renderedLocation.name, renderedLocation.filter));
      return;
    }
    dialogs.forEach(dialog => dialog.__close ? dialog.__close() : dialog.remove());
    if (!routes[name]) { name = 'dashboard'; filter = undefined; }

    // Resolve where this lives in the nav tree (for chrome highlighting).
    let loc = findLeaf(name, filter);
    // Deep-link (hand-typed hash / stale bookmark) into a feature module this workspace
    // doesn't have → bounce to the dashboard rather than let the view 402.
    if (loc && ((loc.primary.requiredModule && !hasModule(loc.primary.requiredModule)) ||
                (loc.subtab.requiredModule && !hasModule(loc.subtab.requiredModule)))) {
      name = 'dashboard'; filter = undefined;
      loc = findLeaf(name, filter);
    }
    if (loc) {
      activePrimaryId = loc.primary.id;
      activeSubtabId = loc.subtab.id;
    }

    renderedLocation = { name, filter };
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
    const previousView = document.getElementById('view');
    const view = previousView.cloneNode(false);
    previousView.replaceWith(view);
    view.dataset.route = name;
    view.dataset.section = activePrimaryId || '';
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
      visibleSubtabs(p).forEach((s) =>
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
        ${visibleSubtabs(p).map((s) => `
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

  // shared = borrowed/shared computer: a short session whose token lives in sessionStorage
  // (ends with the tab) — see src/shared/auth.ts.
  async function login(username, password, shared) {
    const body = { username, password };
    if (shared) body.shared = true;
    const data = await API.post('/auth/login', body);
    API.setToken(data.token, { shared: !!shared });
    me = data.user;
    await showApp();
  }

  async function logout() {
    try { await API.post('/auth/logout'); } catch { /* ignore */ }
    API.clearToken();
    if (App._unreadTimer) clearInterval(App._unreadTimer);
    showLogin();
  }

  function forgotPassword() {
    UI.modal({
      title: 'Reset your password',
      bodyHTML: `<p class="muted" style="margin-top:0">Enter your username or email. If we have an
        address on file and email is set up, you'll get a reset link.</p>
        <label>Username or email</label><input data-f="id" autocomplete="username" />`,
      confirmText: 'Send reset link',
      onConfirm: async (ov, showErr) => {
        const id = ov.querySelector('[data-f="id"]').value.trim();
        if (!id) { showErr('Enter your username or email.'); return false; }
        const r = await API.post('/auth/forgot-password', { identifier: id });
        UI.toast(r.sent ? 'Check your email for the reset link.'
          : (r.reason ? 'Could not send: ' + r.reason : 'If that account exists, a link is on its way.'),
          r.sent ? 'success' : 'error');
      },
    });
  }

  function setNewPassword(token) {
    UI.modal({
      title: 'Set a new password',
      bodyHTML: `<label>New password</label>
        <input data-f="pw" type="password" autocomplete="new-password" placeholder="at least 6 characters" />`,
      confirmText: 'Save & sign in',
      cancelText: 'Cancel',
      onConfirm: async (ov, showErr) => {
        const pw = ov.querySelector('[data-f="pw"]').value;
        if ((pw || '').length < 6) { showErr('Password must be at least 6 characters.'); return false; }
        try {
          await API.post('/auth/reset-password', { token, new_password: pw });
        } catch (e) { showErr(e.message); return false; }
        history.replaceState(null, '', location.pathname + location.hash);
        UI.toast('Password updated — please sign in.', 'success');
      },
    });
  }

  async function boot() {
    // Wire login form
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('login-error');
      errEl.classList.add('hidden');
      const u = document.getElementById('login-username').value.trim();
      const p = document.getElementById('login-password').value;
      const sharedBox = document.getElementById('login-shared');
      try {
        await login(u, p, !!(sharedBox && sharedBox.checked));
        if (sharedBox) sharedBox.checked = false;
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });

    const forgotLink = document.getElementById('forgot-link');
    if (forgotLink) forgotLink.addEventListener('click', forgotPassword);

    // Arriving from a "reset your password" email link.
    const resetToken = new URLSearchParams(location.search).get('reset');
    if (resetToken) setNewPassword(resetToken);

    // Utility bar: menu search + site map + pin glyph.
    document.getElementById('menu-search')
      .insertAdjacentHTML('beforebegin', UI.icon('search', 16));
    wireMenuSearch();
    document.getElementById('sitemap-btn').addEventListener('click', openSiteMap);
    document.getElementById('pin-btn').innerHTML = UI.icon('archive');

    // Right icon rail.
    const railMsg = document.getElementById('rail-messages');
    railMsg.insertAdjacentHTML('afterbegin', UI.icon('messages'));
    railMsg.addEventListener('click', () => navigate('messages'));
    const railNotif = document.getElementById('rail-notifications');
    if (railNotif) {
      railNotif.insertAdjacentHTML('afterbegin', UI.icon('bell'));
      railNotif.addEventListener('click', openNotifications);
    }
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
      if (renderedLocation && parsed.route === renderedLocation.name && filtersEqual(parsed.filter, renderedLocation.filter)) return;
      if (routes[parsed.route]) navigate(parsed.route, parsed.filter);
    });

    // Resume session if token present.
    if (API.getToken()) {
      const departmentsReq = API.get('/users/departments/list');
      departmentsReq.catch(() => {}); // awaited (and its failure handled) in showApp
      try {
        const { user } = await API.get('/auth/me');
        me = user;
        await showApp(departmentsReq);
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
    register, navigate, getMe, getDepartments, isAdmin, hasPermission, hasModule, showLogin, refreshUnread,
    logout, boot, reloadDepartments, setMe, currentLocation,
    _routeNames: () => Object.keys(routes), // test/debug seam
  };
})();

document.addEventListener('DOMContentLoaded', () => App.boot());
