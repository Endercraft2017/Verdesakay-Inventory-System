/* Main application controller: auth, routing, shell wiring. */
const App = (() => {
  let me = null;
  let departments = [];
  const routes = {}; // name -> render(viewEl)

  function register(name, renderFn) { routes[name] = renderFn; }

  function getMe() { return me; }
  function getDepartments() { return departments; }
  function isAdmin() { return me && me.role === 'admin'; }

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

    // Toggle admin-only nav.
    document.querySelectorAll('.admin-only').forEach((el) =>
      el.classList.toggle('hidden', !isAdmin()));

    try { departments = await API.get('/users/departments/list'); } catch { departments = []; }

    refreshUnread();
    if (App._unreadTimer) clearInterval(App._unreadTimer);
    App._unreadTimer = setInterval(refreshUnread, 20000);

    const start = (location.hash || '#dashboard').slice(1);
    navigate(routes[start] ? start : 'dashboard');
  }

  async function refreshUnread() {
    try {
      const { count } = await API.get('/messages/unread-count');
      const badge = document.getElementById('msg-badge');
      badge.textContent = count;
      badge.classList.toggle('hidden', !count);
    } catch { /* ignore */ }
  }

  function navigate(name) {
    if (!routes[name]) name = 'dashboard';
    location.hash = name;
    document.querySelectorAll('.nav-item[data-route]').forEach((b) =>
      b.classList.toggle('active', b.dataset.route === name));
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty">Loading…</div>';
    Promise.resolve(routes[name](view)).catch((e) => {
      view.innerHTML = `<div class="empty">Failed to load: ${UI.esc(e.message)}</div>`;
    });
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

    // Render nav icons (prepend SVG before each item's label).
    document.querySelectorAll('.nav-item[data-icon]').forEach((b) => {
      b.insertAdjacentHTML('afterbegin', UI.icon(b.dataset.icon, 18));
    });

    // Nav buttons
    document.querySelectorAll('.nav-item[data-route]').forEach((b) =>
      b.addEventListener('click', () => navigate(b.dataset.route)));

    // Chrome buttons
    const logoutBtn = document.getElementById('logout-btn');
    logoutBtn.innerHTML = UI.icon('logout');
    logoutBtn.addEventListener('click', logout);
    document.getElementById('theme-btn').addEventListener('click', toggleTheme);
    applyTheme(currentTheme()); // set the correct toggle icon
    window.addEventListener('hashchange', () => {
      const name = location.hash.slice(1);
      if (me && routes[name]) {
        document.querySelectorAll('.nav-item[data-route]').forEach((bb) =>
          bb.classList.toggle('active', bb.dataset.route === name));
      }
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

  return { register, navigate, getMe, getDepartments, isAdmin, showLogin, refreshUnread, logout, boot };
})();

document.addEventListener('DOMContentLoaded', () => App.boot());
