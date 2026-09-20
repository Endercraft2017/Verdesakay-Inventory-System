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
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    var res = await fetch(API + path, { method: method, headers: headers, body: body !== undefined ? JSON.stringify(body) : undefined });
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
        el('td', { text: t.plan }),
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
      name: full.name,
      plan: full.plan,
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

    var planSel = el('select', { id: 'd-plan' }, ref.plans.map(function (p) {
      return el('option', { value: p, text: p, selected: p === st.plan ? 'selected' : null });
    }));
    var statusSel = el('select', { id: 'd-status' }, ref.statuses.map(function (s) {
      return el('option', { value: s, text: s, selected: s === st.status ? 'selected' : null });
    }));
    var trialField = el('div', { class: 'field', id: 'd-trial-field' }, [
      el('label', { text: 'Trial ends' }),
      el('input', { id: 'd-trial', type: 'date', value: st.trial_ends_at ? st.trial_ends_at.slice(0, 10) : '' }),
    ]);

    // modules block
    var modeSel = el('select', { id: 'd-modmode', onchange: function () {
      st.useOverride = this.value === 'custom';
      renderModOptions();
    } }, [
      el('option', { value: 'plan', text: 'Use plan default (' + st.planDefault.join(', ') + ')', selected: st.useOverride ? null : 'selected' }),
      el('option', { value: 'custom', text: 'Custom set', selected: st.useOverride ? 'selected' : null }),
    ]);
    var modOpts = el('div', { class: 'mods', id: 'd-modopts' });

    function renderModOptions() {
      modOpts.innerHTML = '';
      if (!st.useOverride) {
        modOpts.appendChild(el('div', { class: 'muted', text: st.planDefault.join(', ') }));
        return;
      }
      var effective = withDeps(st.mods);
      var depSet = {};
      effective.forEach(function (m) { depsOf(m).forEach(function (d) { depSet[d] = true; }); });
      ref.modules.forEach(function (name) {
        var checkedByUser = !!st.mods[name];
        var pulledIn = !checkedByUser && effective.indexOf(name) !== -1;
        var opt = el('label', { class: 'opt' + (pulledIn ? ' dep' : '') }, [
          el('input', {
            type: 'checkbox',
            checked: (checkedByUser || pulledIn) ? 'checked' : null,
            disabled: pulledIn ? 'disabled' : null,
            onchange: function () { st.mods[name] = this.checked; renderModOptions(); },
          }),
          el('span', { text: name + (pulledIn ? '  (required by another)' : '') }),
        ]);
        modOpts.appendChild(opt);
      });
    }

    var usageBox = el('div', { class: 'usage' });
    if (st.usage) {
      [['users', 'Users'], ['inventory_items', 'Items'], ['storage_mb', 'Storage MB'], ['ai_calls_month', 'AI calls (mo)']]
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
      el('div', { class: 'field' }, [el('label', { text: 'Name' }), el('input', { id: 'd-name', value: st.name || '' })]),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Plan' }), planSel]),
        el('div', { class: 'field' }, [el('label', { text: 'Status' }), statusSel]),
      ]),
      trialField,
      el('div', { class: 'field' }, [el('label', { text: 'Feature modules' }), modeSel, modOpts]),
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
    renderModOptions();
  }

  function closeExisting() {
    var s = $('scrim'), d = $('drawer');
    if (s) s.remove(); if (d) d.remove();
  }

  async function save() {
    var st = drawerState;
    var patch = {
      name: $('d-name').value.trim(),
      plan: $('d-plan').value,
      status: $('d-status').value,
    };
    if ($('d-status').value === 'trial' || $('d-status').value === 'past_due') {
      var v = $('d-trial').value;
      patch.trial_ends_at = v ? new Date(v + 'T00:00:00').toISOString() : null;
    }
    patch.modules = st.useOverride ? withDeps(st.mods) : null;
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

  /* ---------- new workspace ---------- */
  $('new-btn').addEventListener('click', function () {
    var planOpts = ref.plans.map(function (p) {
      return el('option', { value: p, text: p, selected: p === 'starter' ? 'selected' : null });
    });
    var card = el('div', { class: 'card' }, [
      el('h2', { text: 'New workspace' }),
      el('div', { class: 'field' }, [el('label', { text: 'Slug' }), el('input', { id: 'n-slug', placeholder: 'acme' })]),
      el('div', { class: 'field' }, [el('label', { text: 'Company name' }), el('input', { id: 'n-name', placeholder: 'Acme Mfg' })]),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Admin username' }), el('input', { id: 'n-user', placeholder: 'owner' })]),
        el('div', { class: 'field' }, [el('label', { text: 'Admin password' }), el('input', { id: 'n-pass', type: 'password' })]),
      ]),
      el('div', { class: 'field' }, [el('label', { text: 'Plan' }), el('select', { id: 'n-plan' }, planOpts)]),
      el('div', { class: 'err', id: 'n-err' }),
      el('div', { style: 'display:flex;gap:10px;margin-top:6px' }, [
        el('button', { class: 'btn', id: 'n-go' }, ['Create']),
        el('button', { class: 'btn ghost', id: 'n-cancel' }, ['Cancel']),
      ]),
    ]);
    var modal = el('div', { class: 'modal', id: 'modal' }, [card]);
    document.body.appendChild(modal);
    var close = function () { modal.remove(); };
    $('n-cancel').addEventListener('click', close);
    $('n-go').addEventListener('click', async function () {
      $('n-err').textContent = '';
      $('n-go').disabled = true;
      try {
        var created = await api('POST', '/tenants', {
          slug: $('n-slug').value.trim(),
          name: $('n-name').value.trim(),
          admin_username: $('n-user').value.trim(),
          admin_password: $('n-pass').value,
          plan: $('n-plan').value,
        });
        close();
        await load();
        toast('Created ' + created.slug);
        openDrawer(created.slug);
      } catch (ex) { $('n-err').textContent = ex.message; $('n-go').disabled = false; }
    });
  });

  /* ---------- go ---------- */
  if (token()) boot().catch(function () { showLogin(); });
  else showLogin();
})();
