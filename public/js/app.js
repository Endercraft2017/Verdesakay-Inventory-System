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
    document.getElementById('tenant-name').textContent = 'Workspace';
    document.title = 'Otom';
    if (window.ChatWS) ChatWS.disconnect();
    if (window.SyncStatus) SyncStatus.stop();
    appScreen().classList.add('hidden');
    loginScreen().classList.remove('hidden');
    document.getElementById('login-password').value = '';
  }

  function requireNewPassword() {
    appScreen().classList.add('hidden');
    loginScreen().classList.remove('hidden');
    if (window.ChatWS) ChatWS.disconnect();
    let saved = false, resume = false;
    UI.modal({
      title: 'Choose your new password', cancelText: 'Sign out', confirmText: 'Save new password',
      protectChanges: false,
      // All successful dismissal paths share the modal's saving guard, including Escape.
      onCancel: logout,
      onClose: () => {
        if (resume) showApp().catch(error => UI.toast(AuthControls.errorMessage(error), 'error'));
      },
      bodyHTML: `<p>Your temporary password must be replaced before you can access the workspace.</p>
        <label for="required-current">Temporary password</label><input id="required-current" data-f="current" data-label="temporary password" type="password" autocomplete="current-password" />
        <label for="required-new">New password</label><input id="required-new" data-f="new" data-label="new password" type="password" autocomplete="new-password" maxlength="128" aria-describedby="required-policy" />
        <label for="required-confirm">Confirm new password</label><input id="required-confirm" data-f="confirm" data-label="confirmation password" type="password" autocomplete="new-password" maxlength="128" />
        <p id="required-policy" class="muted auth-help">Use 8–128 characters. Common passwords are not accepted. Choose a password different from the temporary one.</p>
        <p class="auth-status" role="status" data-password-status></p>`,
      onOpen: ov => AuthControls.passwords(ov),
      onConfirm: async (ov, showErr) => {
        const button = ov.querySelector('[data-confirm]');
        if (!saved) {
          const current = ov.querySelector('[data-f="current"]');
          const next = ov.querySelector('[data-f="new"]');
          const confirm = ov.querySelector('[data-f="confirm"]');
          if (!current.value) { showErr('Enter your temporary password.'); current.focus(); return false; }
          if (next.value.length < 8 || next.value.length > 128) { showErr('Use 8–128 characters.'); next.focus(); return false; }
          if (next.value !== confirm.value) { showErr('Passwords do not match.'); confirm.focus(); return false; }
          button.textContent = 'Saving…';
          try {
            await API.post('/auth/change-password', { current_password: current.value, new_password: next.value });
            saved = true;
            ov.querySelectorAll('input').forEach(input => { input.value = ''; input.disabled = true; });
            ov.querySelector('[data-password-status]').textContent = 'Password saved. Reopening your workspace…';
          } catch (error) {
            showErr(AuthControls.errorMessage(error)); button.textContent = 'Save new password'; return false;
          }
        }
        button.textContent = 'Opening…';
        try {
          me = (await API.get('/auth/me')).user;
          resume = true;
          return true; // Close before showApp can open another required authentication dialog.
        } catch {
          showErr('Your password was saved, but the workspace could not be loaded. Retry access or sign out and use your new password.');
          button.textContent = 'Retry access';
          return false;
        }
      },
    });
  }

  /** The workspace requires two-step sign-in for this account and it isn't set up yet: the
      server allows nothing else until it is (src/shared/mfa.ts). */
  async function requireMfaSetup() {
    appScreen().classList.add('hidden');
    loginScreen().classList.remove('hidden');
    if (window.ChatWS) ChatWS.disconnect();
    if (!(await Mfa.setup({ forced: true }))) { logout(); return; }
    me = (await API.get('/auth/me')).user;
    await showApp();
  }

  async function showApp(departmentsReq) {
    if (me && me.password_change_required) { requireNewPassword(); return; }
    if (me && me.mfa_setup_required) { requireMfaSetup(); return; }
    loginScreen().classList.add('hidden');
    appScreen().classList.remove('hidden');

    document.getElementById('me-name').textContent = me.full_name;
    document.getElementById('me-role').textContent = me.role_label || me.role;
    document.getElementById('me-dept').textContent = me.department_name || 'No dept';
    document.getElementById('me-avatar').textContent = UI.initials(me.full_name);

    // Signed up online and not paid yet: the server only answers sign-in, Billing and Support, so
    // show just the Billing screen until the first payment is confirmed (src/platform/billing.ts).
    let ws = null;
    try { ws = await API.get('/tenant'); } catch { /* no workspace info: carry on normally */ }
    if (ws) {
      document.getElementById('tenant-name').textContent = ws.name || 'Workspace';
      document.title = `${ws.name || 'Workspace'} · Otom`;
      document.getElementById('tenant-name').title = ws.company_id ? 'Company ID: ' + ws.company_id : '';
    }
    appScreen().classList.toggle('awaiting-payment', !!(ws && ws.awaiting_payment));
    if (ws && ws.awaiting_payment) { showAwaitingPayment(ws); return; }

    try { departments = await (departmentsReq || API.get('/users/departments/list')); } catch { departments = []; }

    renderPrimaryNav(); // (re)build chrome; honours admin-only visibility
    // The AI Assistant bubble is a per-tenant feature module.
    const aiFab = document.getElementById('ai-fab');
    if (aiFab) aiFab.classList.toggle('hidden', !hasModule('ai'));
    await showWorkspaceBanner();

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

  /** The locked shell for a workspace awaiting its first payment: a banner and the Billing screen. */
  function showAwaitingPayment(ws) {
    const aiFab = document.getElementById('ai-fab');
    if (aiFab) aiFab.classList.add('hidden');
    paintBanner(`Welcome, ${ws.name}! Your workspace opens once your first payment is confirmed.`, 'warn', false);
    const view = document.getElementById('view');
    if (routes.billing) routes.billing(view);
  }

  async function showWorkspaceBanner() {
    let t;
    try { t = await API.get('/tenant'); } catch { return; }
    const tenantName = t.name || 'Workspace';
    document.getElementById('tenant-name').textContent = tenantName;
    document.title = `${tenantName} · Otom`;
    let msg = '', tone = 'warn';
    if (t.read_only) { msg = `${t.name} is past due — the workspace is read-only until billing is resolved.`; tone = 'danger'; }
    else if (t.status === 'suspended') { msg = `${t.name} is suspended.`; tone = 'danger'; }
    else if (t.trial_days_left != null && t.trial_days_left <= 14) {
      msg = t.trial_days_left <= 0 ? `${t.name}'s trial has ended.`
        : `${t.name} — trial: ${t.trial_days_left} day${t.trial_days_left === 1 ? '' : 's'} left.`;
    } else if (t.billing && t.billing.open) {
      // Our unpaid invoices to this workspace (only sent to users.manage — see Admin → Billing).
      msg = t.billing.overdue
        ? `${t.billing.overdue} overdue invoice${t.billing.overdue === 1 ? '' : 's'} for ${t.name}.`
        : `${t.billing.open} unpaid invoice${t.billing.open === 1 ? '' : 's'} for ${t.name}.`;
      if (t.billing.overdue) tone = 'danger';
    }
    document.getElementById('ws-banner')?.remove();
    if (msg) paintBanner(msg, tone, !!t.billing);
  }

  function paintBanner(msg, tone, billingLink) {
    document.getElementById('ws-banner')?.remove();
    const bar = document.createElement('div');
    bar.id = 'ws-banner';
    bar.style.cssText = `padding:6px 14px;font-size:13px;text-align:center;color:#fff;`
      + `background:${tone === 'danger' ? 'var(--danger,#d64545)' : 'var(--warn,#b8860b)'}`;
    bar.textContent = msg;
    if (billingLink) {
      const link = document.createElement('button');
      link.type = 'button';
      link.textContent = 'View billing';
      link.style.cssText = 'margin-left:10px;background:transparent;border:1px solid #fff;color:#fff;border-radius:6px;padding:1px 8px;font-size:12px;cursor:pointer';
      link.onclick = () => navigate('billing');
      bar.appendChild(link);
    }
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
          if (n.link?.route === 'tasks' && window.PersonalTools) { m.close(); window.PersonalTools.openScheduler(); }
          else if (n.link && routes[n.link.route]) { m.close(); navigate(n.link.route, n.link.params || undefined); }
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
      if (p.requiredAnyPermission && !p.requiredAnyPermission.some(hasPermission)) return false;
      if (p.requiredModule && !hasModule(p.requiredModule)) return false;
      return visibleSubtabs(p).length > 0;
    });
  }

  /** Visible subtabs for a primary — filtered by requiredPermission and requiredModule. */
  function visibleSubtabs(primary) {
    return (primary.subtabs || []).filter((s) =>
      (!s.requiredPermission || hasPermission(s.requiredPermission)) &&
      (!s.requiredAnyPermission || s.requiredAnyPermission.some(hasPermission)) &&
      (!s.requiredModule || hasModule(s.requiredModule)));
  }

  function filtersEqual(a, b) {
    const ax = a || {}, bx = b || {};
    const ak = Object.keys(ax), bk = Object.keys(bx);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => String(ax[k]) === String(bx[k]));
  }

  function canAccessRoute(route, filter) {
    const loc = findLeaf(route, filter);
    if (!loc) return !!routes[route];
    return visiblePrimaries().includes(loc.primary) && visibleSubtabs(loc.primary).includes(loc.subtab);
  }

  /** Find the first {primary, subtab, leaf} matching a route (+ optional filter). */
  function findLeaf(route, filter) {
    // Section links are shortcuts into the same Documents hub, including deep links.
    if (route === 'form-records') {
      const primary = NAV.find((item) => item.id === 'docs');
      const subtab = primary?.subtabs.find((item) => item.id === 'custom-forms');
      const leaf = subtab?.tree.find((item) => item.route === route);
      if (leaf) return { primary, subtab, leaf };
    }
    let routeFallback = null;
    for (const primary of NAV) {
      for (const subtab of primary.subtabs) {
        for (const leaf of subtab.tree) {
          if (leaf.route !== route) continue;
          if (!routeFallback) routeFallback = { primary, subtab, leaf };
          if (filter === undefined) {
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
      `<button class="subtab ${s.id === activeSubtabId ? 'active' : ''}" ${s.id === activeSubtabId ? 'aria-current="page"' : ''} data-subtab="${s.id}">${UI.esc(s.label)}</button>`
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
      const on = leaf.route === activeRoute && (!leaf.filter || filtersEqual(leaf.filter, activeFilter) || (leaf.filter && Object.keys(leaf.filter).every(key => String(leaf.filter[key]) === String((activeFilter || {})[key]))));
      return `<button class="tree-leaf ${on ? 'active' : ''}" ${on ? 'aria-current="page"' : ''} data-route="${leaf.route}"
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
    document.querySelectorAll('#primary-nav [data-primary]').forEach((b) => {
      const active = b.dataset.primary === activePrimaryId;
      b.classList.toggle('active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }

  /* ---------- Navigation ---------- */

  function navigate(name, filter) {
    if (me && me.password_change_required) return;
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
    } else {
      activePrimaryId = null;
      activeSubtabId = null;
    }

    renderedLocation = { name, filter };
    // Reflect in the URL without triggering a re-navigation.
    suppressHash = true;
    location.hash = hashFor(name, filter);
    renderedLocation = { name, route: name, filter };
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

  function replaceFilters(name, filter) {
    history.replaceState(null, '', '#' + hashFor(name, filter));
    renderedLocation = { name, route: name, filter };
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
      headActionHTML: '<button type="button" class="btn secondary small" data-sitemap-guide>Guide</button>',
      bodyHTML: `<div class="sitemap-grid">${sections}</div>`,
      cancelText: 'Close',
    });
    m.overlay.querySelector('[data-sitemap-guide]').addEventListener('click', () => {
      if (window.Help) Help.open('site-map');
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
    // Two-step sign-in: the password alone opened nothing; the code finishes it (lib/mfa.js).
    const signedIn = data.mfa_required ? await Mfa.askCode(data.mfa_token) : data;
    if (!signedIn) return;
    API.setToken(signedIn.token, { shared: !!shared });
    me = signedIn.user;
    await showApp();
  }

  async function logout() {
    try { await API.post('/auth/logout'); } catch { /* ignore */ }
    API.clearToken();
    if (App._unreadTimer) clearInterval(App._unreadTimer);
    showLogin();
  }

  function forgotPassword() {
      let completed = false;
      const m = UI.modal({ title: 'Recover your login', confirmText: 'Send reset link', protectChanges: true,
          bodyHTML: '<p class="muted" style="margin-top:0">Enter your username or email. If we have an address on file and email is set up, you will receive your username and a password reset link.</p><label for="recovery-identifier">Username or email</label><input id="recovery-identifier" data-f="id" autocomplete="username" maxlength="200" required aria-describedby="recovery-help"/><p id="recovery-help" class="muted auth-help">No email on your account? Ask your administrator to help you recover your login.</p>',
          onClose: () => { if (completed)
              document.getElementById('login-username')?.focus(); },
          onConfirm: async (ov, showErr) => { const input = ov.querySelector('[data-f=id]'); const id = input.value.trim(); if (!id) {
              showErr('Enter your username or email.');
              input.setAttribute('aria-invalid', 'true');
              input.focus();
              return false;
          } const button = ov.querySelector('[data-confirm]'); button.textContent = 'Sending…'; ov.setAttribute('aria-busy', 'true'); try {
              const r = await API.post('/auth/forgot-password', { identifier: id });
              if (r.reason) {
                  showErr(r.reason);
                  return false;
              }
              completed = true;
              m.markSaved();
              ov.querySelector('.modal-body').innerHTML = '<div role="status"><h4>Request received</h4><p>' + UI.esc(r.message || 'If that account exists and has an email address on file, a reset link is on its way. Otherwise ask your administrator to reset your password.') + '</p><p class="muted">Check your inbox and spam folder. Any reset link you receive is valid for one hour. This message does not confirm whether an account or email exists.</p></div>';
              button.hidden = true;
              ov.querySelector('.modal-foot [data-close]').textContent = 'Back to sign in';
              return false;
          }
          catch (e) {
              showErr(AuthControls.errorMessage(e));
              return false;
          }
          finally {
              button.textContent = 'Send reset link';
              ov.removeAttribute('aria-busy');
          } } });
  }
  function setNewPassword(token) {
      let completed = false;
      const m = UI.modal({ title: 'Set a new password', confirmText: 'Save password', protectChanges: true,
          bodyHTML: '<p class="muted auth-help" id="password-policy">Use 8–128 characters. Common passwords are not accepted. You will sign in after saving.</p><label for="reset-password">New password</label><input id="reset-password" data-f="pw" data-label="new password" type="password" autocomplete="new-password" aria-describedby="password-policy" minlength="8" maxlength="128" required/><label for="reset-confirm">Confirm new password</label><input id="reset-confirm" data-f="confirm" data-label="confirmation password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required/><button type="button" class="btn secondary small" data-another-link hidden style="margin-top:12px">Request another reset link</button>',
          onClose: () => { if (completed)
              document.getElementById('login-username')?.focus(); },
          onOpen: ov => { AuthControls.passwords(ov); ov.querySelector('[data-another-link]').onclick = () => { m.markSaved(); m.close(); forgotPassword(); }; },
          onConfirm: async (ov, showErr) => { const input = ov.querySelector('[data-f=pw]'), confirm = ov.querySelector('[data-f=confirm]'); if (input.value.length < 8 || input.value.length > 128) {
              showErr('Password must be 8–128 characters.');
              input.setAttribute('aria-invalid', 'true');
              input.focus();
              return false;
          } if (input.value !== confirm.value) {
              showErr('The passwords do not match.');
              confirm.setAttribute('aria-invalid', 'true');
              confirm.focus();
              return false;
          } const button = ov.querySelector('[data-confirm]'); button.textContent = 'Saving…'; ov.setAttribute('aria-busy', 'true'); try {
              await API.post('/auth/reset-password', { token, new_password: input.value });
              completed = true;
              m.markSaved();
              history.replaceState(null, '', location.pathname + location.hash);
              ov.querySelector('.modal-body').innerHTML = '<div role="status"><h4>Password updated</h4><p>Sign in with your new password. For your account protection, existing sessions have ended.</p></div>';
              button.hidden = true;
              ov.querySelector('.modal-foot [data-close]').textContent = 'Back to sign in';
              return false;
          }
          catch (e) {
              showErr(AuthControls.errorMessage(e));
              if (/reset link|expired/i.test(e.message))
                  ov.querySelector('[data-another-link]').hidden = false;
              return false;
          }
          finally {
              button.textContent = 'Save password';
              ov.removeAttribute('aria-busy');
          } } });
  }

  async function boot() {
    AuthControls.passwords(document.getElementById("login-form"));
    let loginPending = false;
    document.getElementById('login-form').addEventListener('submit', async (e) => { e.preventDefault(); if (loginPending)
        return; const form = e.target, button = form.querySelector('[type=submit]'), errEl = document.getElementById('login-error'), user = document.getElementById('login-username'), pw = document.getElementById('login-password'), sharedBox = document.getElementById('login-shared'); errEl.classList.add('hidden'); if (!user.value.trim()) {
        errEl.textContent = 'Enter your username.';
        errEl.classList.remove('hidden');
        user.setAttribute('aria-invalid', 'true');
        user.focus();
        return;
    } loginPending = true; button.disabled = true; button.textContent = 'Signing in…'; form.setAttribute('aria-busy', 'true'); document.getElementById('login-status').textContent = 'Signing in. Please wait.'; try {
        await login(user.value.trim(), pw.value, !!sharedBox.checked);
        sharedBox.checked = false;
    }
    catch (e) {
        errEl.textContent = AuthControls.errorMessage(e);
        errEl.classList.remove('hidden');
        errEl.focus();
    }
    finally {
        loginPending = false;
        button.disabled = false;
        button.textContent = 'Sign in';
        form.removeAttribute('aria-busy');
        document.getElementById('login-status').textContent = '';
    } });

    const forgotLink = document.getElementById('forgot-link');
    if (forgotLink) forgotLink.addEventListener('click', forgotPassword);

    // Arriving from a "reset your password" email link.
    const resetToken = new URLSearchParams(location.search).get('reset');
    if (resetToken) setNewPassword(resetToken);
    else if (new URLSearchParams(location.search).has("recover")) forgotPassword();

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
    // The header profile is the entry point for My Account.
    document.getElementById('account-btn').addEventListener('click', () => navigate('account'));
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
    register, navigate, replaceFilters, canAccessRoute, getMe, getDepartments, isAdmin, hasPermission, hasModule, showLogin, refreshUnread,
    logout, boot, reloadDepartments, setMe, currentLocation,
    _routeNames: () => Object.keys(routes), // test/debug seam
  };
})();

// Consumers such as Help and API intentionally probe window.App before using it.
// A top-level const is visible to scripts but is not a property of window.
window.App = App;

document.addEventListener('DOMContentLoaded', () => App.boot());
