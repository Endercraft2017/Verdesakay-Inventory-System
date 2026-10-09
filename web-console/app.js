/* Owner console — talks to /_platform/api (src/routes/platform.routes.ts). Vanilla, no
   build step, mirrors the rest of this project. Operator token is separate from any
   tenant's token and lives under its own localStorage key. */
(function () {
  'use strict';
  var TOKEN_KEY = 'vds_platform_token';
  var API = '/_platform/api';
  var ref = null;      // /bootstrap payload: modules, module_deps, plans, plan_modules, statuses
  var tenants = [];
  var me = null;

  /* ---------- tiny helpers ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  };
  function companySlug(name) {
    return name.trim().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function companyIdentity(id) {
    var name = $(id).value.trim();
    if (!name) throw new Error('Enter a company name.');
    var slug = companySlug(name);
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(slug)) {
      throw new Error('Company name must produce a URL name of 2–31 characters starting with a letter.');
    }
    return { name: name, slug: slug };
  }
  function token() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }

  function toast(msg) {
    var t = el('div', { class: 'toast', text: msg });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }

  async function api(method, path, body) {
    var headers = {};
    var tk = token();
    if (tk) headers['Authorization'] = 'Bearer ' + tk;
    var isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
    var payload = body === undefined ? undefined : (isForm ? body : JSON.stringify(body));
    var res = await fetch(API + path, { method: method, headers: headers, body: payload });
    if (res.status === 401) { setToken(null); showLogin(); throw new Error('Session expired — sign in again.'); }
    var data = null;
    if ((res.headers.get('content-type') || '').indexOf('json') !== -1) data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
    return data;
  }

  /* ---------- auth screens ---------- */
  function showLogin() { $('app').classList.add('hidden'); $('login').classList.remove('hidden'); }
  function showApp() { $('login').classList.add('hidden'); $('app').classList.remove('hidden'); }

  $('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('login-err'); err.textContent = '';
    try {
      var r = await api('POST', '/login', { username: $('lu').value.trim(), password: $('lp').value });
      setToken(r.token);
      $('lp').value = '';
      await boot();
    } catch (ex) { err.textContent = ex.message; }
  });

  $('logout').addEventListener('click', async function () {
    try { await api('POST', '/logout'); } catch (e) {}
    setToken(null); showLogin();
  });

  /* ---------- data ---------- */
  async function boot() {
    me = (await api('GET', '/me')).user;
    ref = await api('GET', '/bootstrap');
    $('who').textContent = me.full_name || me.username;
    showApp();
    await load();
  }

  async function load() {
    tenants = await api('GET', '/tenants');
    render();
  }

  /* ---------- table ---------- */
  function statusBadge(s) { return el('span', { class: 'badge ' + s, text: s.replace('_', ' ') }); }

  function moduleChips(m) {
    var wrap = el('span');
    var ovr = m.override; // array or null
    m.effective.forEach(function (name) {
      var isOverride = ovr && ovr.indexOf(name) !== -1;
      wrap.appendChild(el('span', { class: 'chip' + (isOverride ? ' ovr' : ''), text: name }));
    });
    return wrap;
  }

  function render() {
    var q = $('filter').value.trim().toLowerCase();
    var list = tenants.filter(function (t) {
      return !q || t.slug.toLowerCase().indexOf(q) !== -1 || (t.name || '').toLowerCase().indexOf(q) !== -1;
    });
    $('count').textContent = list.length + ' of ' + tenants.length;
    var tb = $('rows'); tb.innerHTML = '';
    list.forEach(function (t) {
      var u = t.usage || {};
      var tr = el('tr', { onclick: function () { openDrawer(t.slug); } }, [
        el('td', { class: 'mono', text: t.slug }),
        el('td', { text: t.name || '' }),
        el('td', {}, [statusBadge(t.status)]),
        el('td', { text: t.subscription ? (t.subscription.mode === 'bundle' ? t.subscription.bundle : 'Per module') : t.plan }),
        el('td', {}, [moduleChips(t.modules)]),
        el('td', { text: u.users != null ? String(u.users) : '–' }),
        el('td', { text: u.inventory_items != null ? String(u.inventory_items) : '–' }),
        el('td', { class: 'muted', text: (t.created_at || '').slice(0, 10) }),
      ]);
      tb.appendChild(tr);
    });
    if (!list.length) tb.appendChild(el('tr', {}, [el('td', { colspan: '8', class: 'muted', text: 'No workspaces.' })]));
  }

  $('filter').addEventListener('input', render);
  $('refresh-btn').addEventListener('click', load);

  /* ---------- module dependency helpers (client mirror of src/modules.ts) ---------- */
  function depsOf(name) { return (ref.module_deps && ref.module_deps[name]) || []; }
  function withDeps(set) {
    var out = {};
    Object.keys(set).forEach(function (name) {
      if (!set[name]) return;
      out[name] = true;
      depsOf(name).forEach(function (d) { out[d] = true; });
    });
    return ref.modules.filter(function (m) { return out[m]; });
  }

  /* ---------- drawer / editor ---------- */
  var drawerState = null;

  async function openDrawer(slug) {
    var full = await api('GET', '/tenants/' + encodeURIComponent(slug));
    drawerState = {
      slug: slug,
      url: full.url,
      name: full.name,
      plan: full.plan,
      subscription: full.subscription,
      status: full.status,
      trial_ends_at: full.trial_ends_at,
      useOverride: !!full.modules.override,
      // working checkbox map for custom mode; seed from the effective set
      mods: full.modules.effective.reduce(function (a, m) { a[m] = true; return a; }, {}),
      planDefault: full.modules.plan_default,
      usage: full.usage,
      photoRetentionDays: full.photo_retention.retention_days,
      photoMaxMb: full.photo_retention.max_mb,
      photoUsageMb: full.photo_retention.usage_mb,
      log: full.log || [],
    };
    paintDrawer();
  }

  function closeDrawer() {
    var s = $('scrim'), d = $('drawer');
    if (s) s.remove();
    if (d) d.remove();
    drawerState = null;
  }

  function paintDrawer() {
    closeExisting();
    var st = drawerState;
    document.body.appendChild(el('div', { id: 'scrim', class: 'scrim', onclick: closeDrawer }));

    var statusSel = el('select', { id: 'd-status' }, ref.statuses.map(function (s) {
      return el('option', { value: s, text: s, selected: s === st.status ? 'selected' : null });
    }));
    var trialField = el('div', { class: 'field', id: 'd-trial-field' }, [
      el('label', { text: 'Trial ends' }),
      el('input', { id: 'd-trial', type: 'date', value: st.trial_ends_at ? st.trial_ends_at.slice(0, 10) : '' }),
    ]);

    var usageBox = el('div', { class: 'usage' });
    if (st.usage) {
      [['employees', 'Employee records'], ['users', 'Login accounts'], ['inventory_items', 'Items'], ['storage_mb', 'Storage MB'], ['ai_calls_month', 'AI calls (mo)']]
        .forEach(function (p) {
          usageBox.appendChild(el('div', {}, [el('span', { text: p[1] }), el('span', { text: String(st.usage[p[0]]) })]));
        });
    } else {
      usageBox.appendChild(el('div', { class: 'muted', text: 'Usage unavailable' }));
    }

    var photoDaysInput = el('input', {
      id: 'd-photo-days', type: 'number', min: '0', step: '1', placeholder: 'Default (60)',
      value: st.photoRetentionDays == null ? '' : String(st.photoRetentionDays),
    });
    var photoMbInput = el('input', {
      id: 'd-photo-mb', type: 'number', min: '0', step: '1', placeholder: 'Default (300)',
      value: st.photoMaxMb == null ? '' : String(st.photoMaxMb),
    });
    var photoField = el('div', { class: 'field' }, [
      el('label', { text: 'Kiosk punch-photo retention' }),
      el('div', { class: 'row2' }, [
        el('div', {}, [el('label', { text: 'Max age (days)', style: 'font-weight:400;font-size:12px' }), photoDaysInput]),
        el('div', {}, [el('label', { text: 'Max total size (MB)', style: 'font-weight:400;font-size:12px' }), photoMbInput]),
      ]),
      el('div', { class: 'muted', style: 'margin-top:4px', text: 'Blank = system default. 0 = no limit. Current usage: ' + (st.photoUsageMb == null ? 'unavailable' : st.photoUsageMb + ' MB') }),
    ]);

    var logBox = el('div', { class: 'log' }, [el('div', { class: 'muted', text: 'Recent activity' })].concat(
      st.log.slice(0, 12).map(function (e) {
        return el('div', { class: 'e' }, [
          el('span', { class: 'when', text: (e.created_at || '') + '  ' }),
          el('span', { text: e.action + (e.detail ? ' — ' + e.detail : '') }),
        ]);
      })
    ));

    var body = el('div', { class: 'body' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Tenant link' }), el('a', { href: st.url, target: '_blank', rel: 'noopener', text: st.url })]),
      el('div', { class: 'field' }, [el('label', { text: 'Name' }), el('input', { id: 'd-name', value: st.name || '' })]),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Subscription' }), el('button', { class: 'btn ghost', onclick: openSubscription }, ['Configure subscription'])]),
        el('div', { class: 'field' }, [el('label', { text: 'Status' }), statusSel]),
      ]),
      trialField,
      el('div', { class: 'field' }, [el('label', { text: 'Subscribed modules' }), el('div', { class: 'muted', text: st.useOverride ? withDeps(st.mods).join(', ') || 'None selected' : st.planDefault.join(', ') })]),
      el('div', { class: 'muted', text: 'Monthly PHP quote: ' + (st.subscription && st.subscription.monthly_total != null ? st.subscription.monthly_total.toFixed(2) : 'Unset') }),
      el('div', { class: 'muted', text: 'Employee allowance: ' + (st.subscription && st.subscription.employee_limit != null ? st.subscription.employee_limit : 'Unlimited') }),
      el('div', { class: 'field' }, [el('label', { text: 'Current usage' }), usageBox]),
      photoField,
      logBox,
      el('div', { class: 'danger-zone' }, [
        el('h3', { text: 'Danger zone' }),
        el('div', { class: 'muted', text: 'Purge deletes this workspace’s database and uploaded files. Irreversible.' }),
        el('button', { class: 'btn danger', style: 'margin-top:8px', onclick: purge }, ['Purge workspace']),
      ]),
    ]);

    var drawer = el('div', { id: 'drawer', class: 'drawer' }, [
      el('header', {}, [el('h1', { text: st.slug }), el('button', { class: 'btn ghost', onclick: closeDrawer }, ['Close'])]),
      body,
      el('div', { class: 'foot' }, [
        el('button', { class: 'btn', id: 'd-save', onclick: save }, ['Save changes']),
        el('button', { class: 'btn ghost', onclick: closeDrawer }, ['Cancel']),
      ]),
    ]);
    document.body.appendChild(drawer);

    function syncTrialVisibility() {
      $('d-trial-field').classList.toggle('hidden', $('d-status').value !== 'trial' && $('d-status').value !== 'past_due');
    }
    statusSel.addEventListener('change', syncTrialVisibility);
    syncTrialVisibility();
  }

  /* ---------- subscription editor ---------- */
  function openSubscription() {
    var st = drawerState;
    var sub = st.subscription || {
      mode: st.useOverride ? 'per_module' : 'bundle', bundle: st.plan,
      modules: withDeps(st.mods), employee_limit: null,
      bundle_price: null, module_prices: {}, employee_price: null,
    };
    sub = JSON.parse(JSON.stringify(sub));
    var selected = {};
    sub.modules.forEach(function (m) { selected[m] = true; });
    var priceInputs = {};
    function moneyInput(value) {
      return el('input', { type: 'number', min: '0', step: '0.01', placeholder: 'Rate unset', value: value == null ? '' : value });
    }
    var mode = el('select', {}, [
      el('option', { value: 'bundle', text: 'Module bundle', selected: sub.mode === 'bundle' ? 'selected' : null }),
      el('option', { value: 'per_module', text: 'Individual modules', selected: sub.mode === 'per_module' ? 'selected' : null }),
    ]);
    var bundle = el('select', {}, ref.plans.map(function (p) {
      return el('option', { value: p, text: p, selected: p === sub.bundle ? 'selected' : null });
    }));
    var bundlePrice = moneyInput(sub.bundle_price);
    var employees = el('input', { type: 'number', min: '0', max: '1000000', step: '1',
      placeholder: 'Unlimited', value: sub.employee_limit == null ? '' : sub.employee_limit });
    var employeePrice = moneyInput(sub.employee_price);
    var bundleModules = el('p', { class: 'muted' });
    var moduleRows = el('div', { class: 'subscription-modules' }, [el('div', { class: 'muted', text: 'Individual module prices: PHP per month' })]);
    var checkboxes = {};
    ref.modules.forEach(function (m) {
      var check = el('input', { type: 'checkbox', checked: selected[m] ? 'checked' : null });
      checkboxes[m] = check;
      var rate = moneyInput(sub.module_prices[m]);
      priceInputs[m] = rate;
      check.addEventListener('change', function () { selected[m] = check.checked; update(); });
      moduleRows.appendChild(el('div', { class: 'subscription-module' }, [
        el('label', {}, [check, el('span', { text: m })]), rate,
      ]));
    });
    var bundleFields = el('div', {}, [
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Bundle' }), bundle]),
        el('div', { class: 'field' }, [el('label', { text: 'Bundle price (PHP / month)' }), bundlePrice]),
      ]), bundleModules,
    ]);
    var quote = el('p', { class: 'subscription-quote' });
    var err = el('div', { class: 'err' });
    var go = el('button', { class: 'btn' }, ['Save subscription']);
    var modal = el('div', { class: 'modal' }, [el('div', { class: 'card subscription-card' }, [
      el('h2', { text: 'Subscription — ' + st.name }),
      el('div', { class: 'field' }, [el('label', { text: 'Module selection' }), mode]),
      bundleFields, moduleRows,
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Maximum employee records' }), employees]),
        el('div', { class: 'field' }, [el('label', { text: 'Price per employee (PHP / month)' }), employeePrice]),
      ]),
      el('p', { class: 'muted', text: 'Blank allowance = unlimited; 0 = no new employees. Counts all HR employee records, including inactive ones. Login account limits remain separate.' }),
      el('p', { class: 'muted', text: 'Monthly quote = bundle or selected module prices + employee allowance × employee price. Required module dependencies are included and priced separately. Blank prices are unset; enter 0 for free. These settings do not collect payments.' }),
      quote, err,
      el('div', { style: 'display:flex;gap:10px' }, [go, el('button', { class: 'btn ghost', onclick: function () { modal.remove(); } }, ['Cancel'])]),
    ])]);
    function amount(input) { return input.value.trim() === '' ? null : Number(input.value); }
    function value() {
      var prices = {};
      ref.modules.forEach(function (m) { prices[m] = amount(priceInputs[m]); });
      return { mode: mode.value, bundle: bundle.value, modules: withDeps(selected),
        employee_limit: amount(employees), bundle_price: amount(bundlePrice),
        module_prices: prices, employee_price: amount(employeePrice) };
    }
    function update() {
      bundleFields.classList.toggle('hidden', mode.value !== 'bundle');
      moduleRows.classList.toggle('hidden', mode.value !== 'per_module');
      bundleModules.textContent = 'Included modules: ' + (ref.plan_modules[bundle.value] || []).join(', ');
      var v = value(), effective = v.modules;
      ref.modules.forEach(function (m) {
        var included = effective.indexOf(m) !== -1;
        checkboxes[m].checked = included;
        checkboxes[m].disabled = included && !selected[m];
        priceInputs[m].disabled = !included;
      });
      var moduleTotal = v.mode === 'bundle' ? v.bundle_price :
        !effective.length || effective.some(function (m) { return v.module_prices[m] === null; }) ? null :
          effective.reduce(function (sum, m) { return sum + Math.round(v.module_prices[m] * 100); }, 0) / 100;
      var employeeTotal = v.employee_limit === 0 ? 0 :
        v.employee_limit === null || v.employee_price === null ? null : v.employee_limit * Math.round(v.employee_price * 100) / 100;
      quote.textContent = moduleTotal === null || employeeTotal === null ? 'Monthly quote: rates or employee allowance unset' :
        'Monthly quote: ' + new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(moduleTotal + employeeTotal) + ' / month';
    }
    mode.addEventListener('change', update);
    bundle.addEventListener('change', update);
    modal.addEventListener('input', function (event) {
      if (event.target.type !== 'checkbox') update();
    });
    go.addEventListener('click', async function () {
      err.textContent = ''; go.disabled = true;
      try {
        await api('PUT', '/tenants/' + encodeURIComponent(st.slug) + '/subscription', value());
        modal.remove(); await load(); await openDrawer(st.slug); toast('Subscription saved');
      } catch (ex) { err.textContent = ex.message; go.disabled = false; }
    });
    document.body.appendChild(modal);
    update();
  }

  function closeExisting() {
    var s = $('scrim'), d = $('drawer');
    if (s) s.remove(); if (d) d.remove();
  }

  async function save() {
    var st = drawerState;
    var patch = {
      name: $('d-name').value.trim(),
      status: $('d-status').value,
    };
    if ($('d-status').value === 'trial' || $('d-status').value === 'past_due') {
      var v = $('d-trial').value;
      patch.trial_ends_at = v ? new Date(v + 'T00:00:00').toISOString() : null;
    }
    var daysStr = $('d-photo-days').value.trim();
    var mbStr = $('d-photo-mb').value.trim();
    patch.photo_retention_days = daysStr === '' ? null : Number(daysStr);
    patch.photo_max_mb = mbStr === '' ? null : Number(mbStr);
    $('d-save').disabled = true;
    try {
      await api('PATCH', '/tenants/' + encodeURIComponent(st.slug), patch);
      toast('Saved ' + st.slug);
      closeDrawer();
      await load();
    } catch (ex) { toast(ex.message); $('d-save').disabled = false; }
  }

  async function purge() {
    var st = drawerState;
    var typed = prompt('Type "' + st.slug + '" to permanently purge this workspace:');
    if (typed == null) return;
    try {
      await api('POST', '/tenants/' + encodeURIComponent(st.slug) + '/purge', { confirm: typed });
      toast('Purged ' + st.slug);
      closeDrawer();
      await load();
    } catch (ex) { toast(ex.message); }
  }

  /* ---------- new tenant ---------- */
  $('new-btn').addEventListener('click', function () {
    var card = el('div', { class: 'card' }, [
      el('h2', { text: 'New tenant' }),
      el('div', { class: 'field' }, [el('label', { text: 'Company name' }), el('input', { id: 'n-name', placeholder: 'Acme Mfg' }), el('small', { class: 'muted', id: 'n-url', text: 'Company name also determines the tenant URL.' })]),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Admin username' }), el('input', { id: 'n-user', placeholder: 'owner' })]),
        el('div', { class: 'field' }, [el('label', { text: 'Admin password' }), el('input', { id: 'n-pass', type: 'password' })]),
      ]),
      el('p', { class: 'muted', text: 'Choose modules, employee allowance, and pricing after creating the tenant.' }),
      el('div', { class: 'err', id: 'n-err' }),
      el('div', { style: 'display:flex;gap:10px;margin-top:6px' }, [
        el('button', { class: 'btn', id: 'n-go' }, ['Create']),
        el('button', { class: 'btn ghost', id: 'n-cancel' }, ['Cancel']),
      ]),
    ]);
    var modal = el('div', { class: 'modal', id: 'modal' }, [card]);
    document.body.appendChild(modal);
    var close = function () { modal.remove(); };
    $('n-name').addEventListener('input', function () {
      $('n-url').textContent = 'Tenant URL name: /' + companySlug(this.value);
    });
    $('n-cancel').addEventListener('click', close);
    $('n-go').addEventListener('click', async function () {
      $('n-err').textContent = '';
      $('n-go').disabled = true;
      try {
        var company = companyIdentity('n-name');
        var created = await api('POST', '/tenants', {
          slug: company.slug,
          name: company.name,
          admin_username: $('n-user').value.trim(),
          admin_password: $('n-pass').value,
        });
        close();
        await load();
        toast('Created ' + created.slug);
        await openDrawer(created.slug);
        openSubscription();
      } catch (ex) { $('n-err').textContent = ex.message; $('n-go').disabled = false; }
    });
  });

  /* ---------- import an existing workspace (.db file) ---------- */
  $('import-btn').addEventListener('click', function () {
    var card = el('div', { class: 'card' }, [
      el('h2', { text: 'Import workspace' }),
      el('p', { class: 'muted', text: 'Upload a database snapshot from an existing install (npm run backup). ' +
        'Its users, passwords and records carry over unchanged. Uploaded files are not included.' }),
      el('div', { class: 'field' }, [el('label', { text: 'Database file' }), el('input', { id: 'i-file', type: 'file', accept: '.db,.sqlite,.sqlite3' })]),
      el('div', { class: 'field' }, [el('label', { text: 'Company name' }), el('input', { id: 'i-name', placeholder: 'Acme Mfg' }), el('small', { class: 'muted', id: 'i-url', text: 'Company name also determines the tenant URL.' })]),
      el('p', { class: 'muted', text: 'Configure subscription pricing after import. Existing records are retained.' }),
      el('div', { class: 'err', id: 'i-err' }),
      el('div', { style: 'display:flex;gap:10px;margin-top:6px' }, [
        el('button', { class: 'btn', id: 'i-go' }, ['Import']),
        el('button', { class: 'btn ghost', id: 'i-cancel' }, ['Cancel']),
      ]),
    ]);
    var modal = el('div', { class: 'modal', id: 'modal' }, [card]);
    document.body.appendChild(modal);
    var close = function () { modal.remove(); };
    $('i-name').addEventListener('input', function () {
      $('i-url').textContent = 'Tenant URL name: /' + companySlug(this.value);
    });
    $('i-cancel').addEventListener('click', close);
    $('i-go').addEventListener('click', async function () {
      $('i-err').textContent = '';
      var f = $('i-file').files[0];
      if (!f) { $('i-err').textContent = 'Choose a database file.'; return; }
      var company;
      try { company = companyIdentity('i-name'); }
      catch (ex) { $('i-err').textContent = ex.message; return; }
      var fd = new FormData();
      fd.append('db', f);
      fd.append('slug', company.slug);
      fd.append('name', company.name);
      fd.append('plan', 'complete');
      $('i-go').disabled = true;
      $('i-go').textContent = 'Importing…';
      try {
        var created = await api('POST', '/tenants/import', fd);
        close();
        await load();
        toast('Imported ' + created.slug + ' (' + created.imported_users + ' users)');
        await openDrawer(created.slug);
        openSubscription();
      } catch (ex) { $('i-err').textContent = ex.message; $('i-go').disabled = false; $('i-go').textContent = 'Import'; }
    });
  });

  /* ---------- go ---------- */
  if (token()) boot().catch(function () { showLogin(); });
  else showLogin();
})();
