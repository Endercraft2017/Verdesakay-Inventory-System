(function () {
  'use strict';
  var slug = function (v) { return v.trim().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); };
  var LABELS = { inventory: 'Inventory', manufacturing: 'Manufacturing', purchasing: 'Purchasing', hr: 'HR & Payroll', accounting: 'Accounting (WIP)', ai: 'AI (separate verification)', mobile: 'Mobile web app', email: 'Email (provider verification)', quickbooks: 'QuickBooks (separate verification)' };
  var signupsOpen = false;
  var signupKey = null;
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
      var headers = { 'X-Session-Mode': 'cookie', 'X-Requested-With': 'VDS', 'Content-Type': 'application/json', 'X-Client': /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'mobile' : 'desktop' };
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
      if (!result.browser_session || !/^\/[a-z][a-z0-9-]{1,30}$/.test(result.workspace_path || '')) throw new Error('Unable to open your workspace. Please try again.');
      // Match the app's session storage convention; credentials and tokens never enter the URL.
      localStorage.removeItem('vds_token'); sessionStorage.removeItem('vds_token');
      var scope = 'tenant:' + result.workspace_path + ':';
      localStorage.removeItem(scope + 'vds_token'); sessionStorage.removeItem(scope + 'vds_token');
      (result.session && result.session.shared ? sessionStorage : localStorage).setItem(scope + 'vds_browser_session', '1');
      // Keep the same device identity when the tenant's scoped API client takes over.
      if (headers['X-Device-Id']) localStorage.setItem(scope + 'vds_device_id', headers['X-Device-Id']);
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
    if (button.disabled) return;
    error.textContent = ''; button.disabled = true;
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 20000);
    try {
      if (!signupKey) signupKey = crypto.randomUUID();
      var name = document.getElementById('company').value.trim();
      var r = await fetch('/api/signup', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': signupKey }, body: JSON.stringify({ slug: slug(name), company_name: name, admin_username: document.getElementById('username').value.trim(), admin_email: document.getElementById('email').value.trim(), admin_password: document.getElementById('password').value, modules: selectedModules(), seats: Number(document.getElementById('seats').value) }) });
      var data = await r.json().catch(function () { return null; });
      if (!r.ok) throw new Error((data && data.error) || 'Registration failed.');
      if (r.status !== 201 || !data || typeof data.slug !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(data.slug)) throw new Error('Registration was not confirmed. Retry with the same details.');
      window.location.assign('/' + encodeURIComponent(data.slug));
    } catch (ex) { error.textContent = controller.signal.aborted ? 'Registration timed out. Retry with the same details.' : ex.message; button.disabled = false; }
    finally { clearTimeout(timer); }
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
  // One immutable same-page request is retried until an exact acknowledgement.
  // An abort/HTTP error does not prove that the server failed to record it.
  var inquiryKey = null, inquiryBody = null, inquiryConfirmed = false;
  document.getElementById('contact-new').addEventListener('click', function () {
    if (!inquiryConfirmed) return;
    inquiryKey = null; inquiryBody = null; inquiryConfirmed = false;
    var form = document.getElementById('contact-form');
    form.reset();
    window.AFKInquiry.unlock();
    form.querySelector('.error').textContent = '';
    form.classList.remove('hidden');
    document.getElementById('contact-done').classList.add('hidden');
    var button = document.getElementById('contact-submit');
    button.disabled = false; button.textContent = 'Send inquiry →';
    document.getElementById('c-intent').focus();
  });
  document.getElementById('contact-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var form = this, error = form.querySelector('.error'), button = document.getElementById('contact-submit');
    if (button.disabled || inquiryConfirmed) return;
    error.textContent = '';
    if (!window.AFKInquiry) { error.textContent = 'The inquiry form did not load correctly. Reload or use the listed direct contact option.'; return; }
    var adapter = window.AFKInquiry;
    var get = function (id) { return document.getElementById(id).value.trim(); };
    if (!inquiryBody) {
      if (!get('c-name')) { error.textContent = 'Enter your name.'; return; }
      if (!adapter.company()) { error.textContent = 'Enter your company, or choose the individual referral option if it applies.'; return; }
      if (!document.getElementById('c-email').checkValidity() || !get('c-email')) { error.textContent = 'Enter a valid email address.'; return; }
      if (get('c-name').length > 120 || adapter.company().length > 160 || get('c-email').length > 254) { error.textContent = 'Please shorten the name, company or email address.'; return; }
      if (get('c-phone').length > 40 || !/^[0-9+() \-]*$/.test(get('c-phone'))) { error.textContent = 'Enter a valid mobile number, or leave it empty.'; return; }
      if (!window.crypto || !window.crypto.randomUUID) { error.textContent = 'Use a current browser on a secure connection to send this form.'; return; }
      try {
        var modules = adapter.partner() ? [] : Array.prototype.slice.call(document.querySelectorAll('#contact-modules input:checked')).map(function (i) { return i.value; });
        var nextBody = JSON.stringify({ name: get('c-name'), company: adapter.company(), email: get('c-email'), phone: get('c-phone'), employees: adapter.partner() ? '' : document.getElementById('c-employees').value, modules: modules, message: adapter.message(get('c-message')), website: get('c-website') });
        var nextKey = window.crypto.randomUUID();
        inquiryBody = nextBody; inquiryKey = nextKey;
        adapter.lock();
      } catch (ex) { error.textContent = ex.message || 'Please check your inquiry details.'; return; }
    }
    button.disabled = true; button.textContent = 'Sending…';
    var controller = new AbortController();
    var deadline = setTimeout(function () { controller.abort(); }, 20000);
    try {
      var r = await fetch('/site/inquiry', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': inquiryKey }, body: inquiryBody });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(data && data.error || 'Your inquiry could not be confirmed.');
      if (r.status !== 201 || !data || data.ok !== true) throw new Error('Your inquiry could not be confirmed.');
      inquiryConfirmed = true;
      form.classList.add('hidden');
      document.getElementById('contact-done').classList.remove('hidden');
      document.getElementById('contact-new').focus();
    } catch (ex) {
      error.textContent = (controller.signal.aborted ? 'Sending timed out.' : (ex.message || 'Unable to connect.')) + ' Confirmation is pending. Retry this exact inquiry here. For corrections, use the listed direct contact option and mention this attempt.';
      button.disabled = false; button.textContent = 'Retry same inquiry →';
    } finally { clearTimeout(deadline); }
  });
  var path = window.location.pathname;
  if (path === '/login') document.getElementById('login-dialog').showModal();
  if (path === '/signup' || path === '/contact') document.getElementById(path === '/signup' && signupsOpen ? 'signup-dialog' : 'contact-dialog').showModal();
})();
