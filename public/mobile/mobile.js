/* Minimal mobile app: login, then show the account holder's name centered.
   Reuses the shared API client (/js/api.js) and its bearer token, so a session
   started here works on the desktop app too (same origin). */
(function () {
  var loginScreen = document.getElementById('m-login');
  var homeScreen = document.getElementById('m-home');
  var loginForm = document.getElementById('m-login-form');
  var loginError = document.getElementById('m-login-error');
  var nameEl = document.getElementById('m-name');
  var metaEl = document.getElementById('m-meta');

  function show(screen) {
    loginScreen.classList.toggle('hidden', screen !== 'login');
    homeScreen.classList.toggle('hidden', screen !== 'home');
  }

  function showLogin() {
    API.clearToken();
    document.getElementById('m-password').value = '';
    show('login');
  }
  // api.js calls window.App.showLogin() on a 401 — provide a minimal shim.
  window.App = { showLogin: showLogin };

  function showHome(user) {
    nameEl.textContent = user.full_name || user.username || 'Unknown';
    var bits = [];
    if (user.role) bits.push(user.role);
    if (user.department_name) bits.push(user.department_name);
    metaEl.textContent = bits.join(' · ');
    show('home');
  }

  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    loginError.classList.add('hidden');
    var btn = loginForm.querySelector('button');
    btn.disabled = true;
    var username = document.getElementById('m-username').value.trim();
    var password = document.getElementById('m-password').value;

    API.post('/auth/login', { username: username, password: password })
      .then(function (res) {
        API.setToken(res.token);
        showHome(res.user);
      })
      .catch(function (err) {
        loginError.textContent = err.message || 'Sign in failed';
        loginError.classList.remove('hidden');
      })
      .finally(function () { btn.disabled = false; });
  });

  document.getElementById('m-logout').addEventListener('click', function () {
    API.post('/auth/logout').catch(function () {}).finally(showLogin);
  });

  // On load: if we already have a valid session, skip straight to home.
  if (API.getToken()) {
    API.get('/auth/me')
      .then(function (res) { showHome(res.user); })
      .catch(function () { showLogin(); });
  } else {
    showLogin();
  }
})();
