(function () {
  'use strict';
  var slug = function (v) { return v.trim().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); };
  var LABELS = { inventory: 'Inventory', manufacturing: 'Manufacturing', purchasing: 'Purchasing', hr: 'HR & Payroll', accounting: 'Accounting', ai: 'AI Assistant', mobile: 'Mobile app', email: 'Email', quickbooks: 'QuickBooks' };
  var signupsOpen = false;
  document.querySelectorAll('[data-open]').forEach(function (b) { b.addEventListener('click', function () {
    // Self-service sign-up is off unless the owner opens it; every "sign up" path leads to Talk to us.
    var which = b.dataset.open === 'signup' && !signupsOpen ? 'contact' : b.dataset.open;
    document.getElementById(which + '-dialog').showModal();
  }); });
  document.querySelectorAll('.close').forEach(function (b) { b.addEventListener('click', function () { b.closest('dialog').close(); }); });
  var loginForm = document.getElementById('login-form');
  var loginChallenge = null;
  var loginCompany = '';
  function resetLoginStep() {
    loginChallenge = null;
    document.getElementById('login-credentials').hidden = false;
    document.querySelectorAll('#login-credentials input').forEach(function (input) { input.disabled = false; });
    document.getElementById('login-mfa').hidden = true;
    document.getElementById('login-code').required = false;
    document.getElementById('login-code').value = '';
    document.getElementById('login-submit').textContent = 'Log in →';
    loginForm.querySelector('.error').textContent = '';
  }
  document.getElementById('login-back').onclick = resetLoginStep;
  document.getElementById('login-dialog').addEventListener('close', function () {
    resetLoginStep(); document.getElementById('login-password').value = '';
  });
  loginForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    var button = document.getElementById('login-submit');
    if (button.disabled) return;
    var shared = document.getElementById('login-shared').checked;
    var errorBox = this.querySelector('.error');
    errorBox.textContent = '';
    button.disabled = true; button.textContent = 'Logging in…';
    try {
      if (!loginChallenge) loginCompany = document.getElementById('login-company').value.trim().toUpperCase();
      var payload = loginChallenge
        ? { company_id: loginCompany, mfa_token: loginChallenge, code: document.getElementById('login-code').value.trim() }
        : { company_id: loginCompany, username: document.getElementById('login-username').value.trim(), password: document.getElementById('login-password').value, shared: shared };
      var headers = { 'Content-Type': 'application/json', 'X-Client': /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'mobile' : 'desktop' };
      try {
        var device = localStorage.getItem('vds_device_id');
        if (!device) { device = crypto.randomUUID(); localStorage.setItem('vds_device_id', device); }
        headers['X-Device-Id'] = device;
      } catch (ignored) {}
      var response = await fetch(loginChallenge ? '/site/login/mfa' : '/site/login', { method: 'POST', headers: headers, body: JSON.stringify(payload) });
      var result = await response.json();
      if (!response.ok) throw new Error(response.status === 401 ? (loginChallenge ? 'Invalid or expired verification code. Try again or go back to log in.' : 'Company ID, username, or password is incorrect.') : result.error || 'Unable to log in. Please try again.');
      if (result.mfa_required) {
        loginChallenge = result.mfa_token;
        document.getElementById('login-credentials').hidden = true;
        document.querySelectorAll('#login-credentials input').forEach(function (input) { input.disabled = true; });
        document.getElementById('login-mfa').hidden = false;
        document.getElementById('login-code').required = true;
        document.getElementById('login-password').value = '';
        document.getElementById('login-code').focus();
        return;
      }
      if (!result.token || !/^\/[a-z][a-z0-9-]{1,30}$/.test(result.workspace_path || '')) throw new Error('Unable to open your workspace. Please try again.');
      // Match the app's session storage convention; credentials and tokens never enter the URL.
      localStorage.removeItem('vds_token'); sessionStorage.removeItem('vds_token');
      (result.session && result.session.shared ? sessionStorage : localStorage).setItem('vds_token', result.token);
      window.location.assign(result.workspace_path + '/');
    } catch (error) { errorBox.textContent = error.message || 'Unable to connect. Please try again.'; }
    finally { button.disabled = false; button.textContent = loginChallenge ? 'Verify and log in →' : 'Log in →'; }
  });
  document.getElementById('company').addEventListener('input', function () { document.getElementById('slug-preview').textContent = 'Your workspace: /' + slug(this.value); });
  document.getElementById('seats').addEventListener('input', function () { showEstimate(); });
  var moduleChecks = {}, moduleDeps = {}, pricing = null;
  var peso = function (n) { return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  /* The monthly total from the owner's price list, or a note when some choice has no price yet. */
  function showEstimate() {
    var out = document.getElementById('signup-estimate');
    if (!out || !pricing) return;
    var seats = Number(document.getElementById('seats').value) || 0;
    var mods = selectedModules(), total = 0, missing = false;
    mods.forEach(function (m) { if (typeof pricing.module_prices[m] === 'number') total += pricing.module_prices[m]; else missing = true; });
    if (pricing.seat_price == null) missing = true; else total += seats * pricing.seat_price;
    out.textContent = missing || !mods.length
      ? 'We will send your first invoice after you sign up. Your workspace opens once that payment is confirmed.'
      : 'Monthly total: ' + peso(total) + (pricing.vat_registered ? ' (VAT included)' : '') + '. You pay the first month before your workspace opens.';
  }
  function selectedModules() { return Object.keys(moduleChecks).filter(function (m) { return moduleChecks[m].checked; }); }
  function syncModuleDeps() {
    var required = {};
    selectedModules().forEach(function (m) { (moduleDeps[m] || []).forEach(function (dep) { required[dep] = true; }); });
    Object.keys(moduleChecks).forEach(function (m) { moduleChecks[m].disabled = !!required[m]; if (required[m]) moduleChecks[m].checked = true; });
  }
  fetch('/site/config').then(function (r) { if (!r.ok) throw new Error(); return r.json(); }).then(function (c) {
    var how = [c.payment_methods && c.payment_methods.gcash ? 'GCash' : null, c.payment_methods && c.payment_methods.bank ? 'bank transfer' : null].filter(Boolean).join(' or ') || 'GCash or bank transfer';
    document.getElementById('signup-info').textContent = c.signups_open
      ? 'Create your workspace, then pay the first month by ' + how + ' from inside it. It opens as soon as we confirm your payment. Employee records are unlimited.'
      : 'Self-service registration is not open yet. New subscriptions are currently set up by the platform owner.';
    pricing = c.pricing || null;
    signupsOpen = !!c.signups_open;
    document.querySelectorAll('.signup-only').forEach(function (el) { el.classList.toggle('hidden', !signupsOpen); });
    showContact(c.contact || {});
    var box = document.getElementById('contact-modules');
    c.modules.forEach(function (m) {
      var label = document.createElement('label'), check = document.createElement('input');
      check.type = 'checkbox'; check.value = m;
      label.append(check, document.createTextNode(LABELS[m] || m));
      box.appendChild(label);
    });
    document.getElementById('signup-submit').disabled = !c.signups_open;
    moduleDeps = c.module_deps;
    c.modules.forEach(function (m) {
      var label = document.createElement('label'), check = document.createElement('input');
      check.type = 'checkbox'; check.checked = true; moduleChecks[m] = check;
      check.addEventListener('change', function () { syncModuleDeps(); showEstimate(); }); label.append(check, document.createTextNode(m));
      document.getElementById('signup-modules').appendChild(label);
    });
    syncModuleDeps();
    showEstimate();
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
  /* The owner's direct contact details (console → Inquiries → Website contact details), when set. */
  function showContact(c) {
    var box = document.getElementById('contact-direct');
    box.replaceChildren();
    function line(label, text, href) {
      var row = document.createElement('div'), a = document.createElement('a');
      a.href = href; a.textContent = text;
      if (/^https:/.test(href)) { a.target = '_blank'; a.rel = 'noopener'; }
      row.append(document.createTextNode(label + ' '), a); box.appendChild(row);
    }
    if (c.phone) line('Call or text', c.phone, 'tel:' + c.phone.replace(/[^+\d]/g, ''));
    if (c.email) line('Email', c.email, 'mailto:' + c.email);
    if (c.messenger) line('Message us on', 'Messenger', c.messenger);
    if (box.children.length) {
      var lead = document.createElement('div'); lead.textContent = 'Prefer to reach us directly?';
      lead.style.fontWeight = '650'; box.prepend(lead);
    }
    box.classList.toggle('hidden', !box.children.length);
  }
  document.getElementById('contact-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var form = this, error = form.querySelector('.error'), button = document.getElementById('contact-submit');
    error.textContent = '';
    var get = function (id) { return document.getElementById(id).value.trim(); };
    if (!get('c-name') || !get('c-company')) { error.textContent = 'Enter your name and company.'; return; }
    if (!document.getElementById('c-email').checkValidity() || !get('c-email')) { error.textContent = 'Enter a valid email address.'; return; }
    button.disabled = true; button.textContent = 'Sending…';
    try {
      var modules = Array.prototype.slice.call(document.querySelectorAll('#contact-modules input:checked')).map(function (i) { return i.value; });
      var r = await fetch('/site/inquiry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: get('c-name'), company: get('c-company'), email: get('c-email'), phone: get('c-phone'),
        employees: document.getElementById('c-employees').value, modules: modules, message: get('c-message'), website: get('c-website') }) });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(data.error || 'Your message could not be sent. Please try again.');
      form.classList.add('hidden');
      document.getElementById('contact-done').classList.remove('hidden');
    } catch (ex) { error.textContent = ex.message; button.disabled = false; button.textContent = 'Send →'; }
  });
  var path = window.location.pathname;
  if (path === '/login') document.getElementById('login-dialog').showModal();
  if (path === '/signup' || path === '/contact') document.getElementById(path === '/signup' && signupsOpen ? 'signup-dialog' : 'contact-dialog').showModal();
})();
