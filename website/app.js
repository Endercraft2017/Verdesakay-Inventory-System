(function () {
  'use strict';
  var slug = function (v) { return v.trim().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); };
  document.querySelectorAll('[data-open]').forEach(function (b) { b.addEventListener('click', function () { document.getElementById(b.dataset.open + '-dialog').showModal(); }); });
  document.querySelectorAll('.close').forEach(function (b) { b.addEventListener('click', function () { b.closest('dialog').close(); }); });
  document.getElementById('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = slug(document.getElementById('login-company').value);
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) { this.querySelector('.error').textContent = 'Enter a valid company URL name.'; return; }
    window.location.assign('/' + encodeURIComponent(name));
  });
  document.getElementById('company').addEventListener('input', function () { document.getElementById('slug-preview').textContent = 'Your workspace: /' + slug(this.value); });
  var moduleChecks = {}, moduleDeps = {};
  function selectedModules() { return Object.keys(moduleChecks).filter(function (m) { return moduleChecks[m].checked; }); }
  function syncModuleDeps() {
    var required = {};
    selectedModules().forEach(function (m) { (moduleDeps[m] || []).forEach(function (dep) { required[dep] = true; }); });
    Object.keys(moduleChecks).forEach(function (m) { moduleChecks[m].disabled = !!required[m]; if (required[m]) moduleChecks[m].checked = true; });
  }
  fetch('/site/config').then(function (r) { if (!r.ok) throw new Error(); return r.json(); }).then(function (c) {
    document.getElementById('signup-info').textContent = c.signups_open ? 'Create a 14-day trial workspace with up to ' + c.trial_seats + ' login seats. Employee records are unlimited. No payment is collected.' : 'Self-service registration is not open yet. New subscriptions are currently set up by the platform owner.';
    document.getElementById('signup-submit').disabled = !c.signups_open;
    moduleDeps = c.module_deps;
    c.modules.forEach(function (m) {
      var label = document.createElement('label'), check = document.createElement('input');
      check.type = 'checkbox'; check.checked = true; moduleChecks[m] = check;
      check.addEventListener('change', syncModuleDeps); label.append(check, document.createTextNode(m));
      document.getElementById('signup-modules').appendChild(label);
    });
    syncModuleDeps();
  }).catch(function () { document.getElementById('signup-info').textContent = 'Registration availability could not be checked. Please try again later.'; });
  document.getElementById('signup-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var error = this.querySelector('.error'), button = document.getElementById('signup-submit');
    error.textContent = ''; button.disabled = true;
    try {
      var name = document.getElementById('company').value.trim();
      var r = await fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: slug(name), company_name: name, admin_username: document.getElementById('username').value.trim(), admin_email: document.getElementById('email').value.trim(), admin_password: document.getElementById('password').value, modules: selectedModules(), seats: Number(document.getElementById('seats').value) }) });
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Registration failed.');
      window.location.assign('/' + encodeURIComponent(data.slug));
    } catch (ex) { error.textContent = ex.message; button.disabled = false; }
  });
  if (window.location.pathname === '/login' || window.location.pathname === '/signup') document.getElementById(window.location.pathname.slice(1) + '-dialog').showModal();
})();
