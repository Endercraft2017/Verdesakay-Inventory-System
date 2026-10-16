/* Owner console — talks to /_platform/api (src/routes/platform.routes.ts). Vanilla, no
   build step, mirrors the rest of this project. Operator sessions use a separate HttpOnly cookie; legacy localStorage tokens are removed. */
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
      if (attrs[k] == null) return; // `selected: cond ? 'selected' : null` must leave the attribute off
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
  function token() { return null; }
  function setToken(t) { try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} }

  function toast(msg) {
    var t = el('div', { class: 'toast', text: msg });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }

  async function api(method, path, body, retried) {
    var headers = { 'X-Requested-With': 'VDS', 'X-Session-Mode': 'cookie' };
    var tk = token();
    if (tk) headers['Authorization'] = 'Bearer ' + tk;
    var isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
    var payload = body === undefined ? undefined : (isForm ? body : JSON.stringify(body));
    var res = await fetch(API + path, { method: method, headers: headers, body: payload });
    if (res.status === 401) { setToken(null); showLogin(); throw new Error('Session expired — sign in again.'); }
    var data = null;
    if ((res.headers.get('content-type') || '').indexOf('json') !== -1) data = await res.json();
    if (res.status === 403 && data && data.passkey_required && !retried && path.indexOf('/passkeys') !== 0) {
      await verifyConsolePasskey();
      return api(method, path, body, true);
    }
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
      if (r.passkey_required) {
        var response = await ConsoleWebAuthn.startAuthentication({ optionsJSON: r.options });
        r = await api('POST', '/passkeys/login', { token: r.token, response: response });
      }
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
    var identity = await api('GET', '/me');
    me = identity.user;
    if (identity.passkey_setup_required) { showPasskeySettings(true); return; }
    ref = await api('GET', '/bootstrap');
    $('who').textContent = me.full_name || me.username;
    showApp();
    await load();
    if (window.ConsoleBilling) window.ConsoleBilling.refreshCount();
    if (window.ConsoleInquiries) window.ConsoleInquiries.refreshCount();
  }

  async function load(refreshSelected) {
    tenants = await api('GET', '/tenants');
    render();
    if (refreshSelected && drawerState && tenants.some(function (t) { return t.slug === drawerState.slug; })) await openDrawer(drawerState.slug, activeTab);
    else if (!drawerState && tenants.length) await openDrawer(tenants[0].slug);
  }

  /* ---------- table ---------- */
  function statusBadge(s) { return el('span', { class: 'badge ' + s, text: s.replace('_', ' ') }); }
  /** Status, plus an "awaiting payment" badge for a website sign-up that hasn't paid yet. */
  function statusBadges(t) {
    var wrap = el('span', { class: 'badge-row' }, [statusBadge(t.status)]);
    if (t.awaiting_payment) wrap.appendChild(el('span', { class: 'badge awaiting', text: 'awaiting payment' }));
    return wrap;
  }

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
      return !q || t.slug.toLowerCase().indexOf(q) !== -1 || (t.company_id || '').toLowerCase().indexOf(q) !== -1 || (t.name || '').toLowerCase().indexOf(q) !== -1;
    });
    $('count').textContent = list.length + ' of ' + tenants.length;
    var tb = $('rows'); tb.innerHTML = '';
    list.forEach(function (t) {
      tb.appendChild(el('button', { class: 'tenant-choice' + (drawerState && drawerState.slug === t.slug ? ' selected' : ''),
        'aria-pressed': drawerState && drawerState.slug === t.slug ? 'true' : 'false',
        onclick: function () { openDrawer(t.slug).catch(function (e) { toast(e.message); }); } }, [
        el('strong', { text: (t.name || t.slug) + (t.is_sandbox ? ' (Sandbox)' : '') }),
        el('span', { class: 'tenant-meta' }, [el('span', { text: (t.company_id ? t.company_id + ' · ' : '') + t.slug }), statusBadges(t)]),
      ]));
    });
    if (!list.length) tb.appendChild(el('p', { class: 'muted', text: q ? 'No matching tenants.' : 'No tenants yet.' }));
  }

  $('filter').addEventListener('input', render);
  $('refresh-btn').addEventListener('click', function () { load(true).catch(function (e) { toast(e.message); }); });

  /* ---------- shared with billing.js ---------- */
  window.Console = {
    api: api, el: el, toast: toast, $: $, token: token,
    tenants: function () { return tenants; },
    refs: function () { return ref; },
    newTenant: function (prefill) { openNewTenant(prefill); },
    openTenant: function (slug) { return openDrawer(slug); },
    reloadTenant: function (slug) { return load(true).then(function () { if (slug) return openDrawer(slug, 'billing'); }); },
  };

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

  var activeTab = 'overview';
  var selectionVersion = 0;
  async function openDrawer(slug, tab) {
    var version = ++selectionVersion;
    var full = await api('GET', '/tenants/' + encodeURIComponent(slug));
    if (version !== selectionVersion) return;
    drawerState = {
      slug: slug,
      url: full.url,
      name: full.name,
      companyId: full.company_id,
      plan: full.plan,
      subscription: full.subscription,
      status: full.status,
      awaiting_payment: !!full.awaiting_payment,
      trial_ends_at: full.trial_ends_at,
      useOverride: !!full.modules.override,
      // working checkbox map for custom mode; seed from the effective set
      mods: full.modules.effective.reduce(function (a, m) { a[m] = true; return a; }, {}),
      planDefault: full.modules.plan_default,
      usage: full.usage,
      photoRetentionDays: full.photo_retention.retention_days,
      photoMaxMb: full.photo_retention.max_mb,
      photoUsageMb: full.photo_retention.usage_mb,
      owner: full.owner,
      isSandbox: full.is_sandbox,
      log: full.log || [],
    };
    activeTab = tab || 'overview';
    render(); paintFrame();
    await selectTab(activeTab);
  }

  function closeDrawer() {
    drawerState = null; ++selectionVersion;
    $('tenant-workspace').replaceChildren(el('div', { class: 'dashboard-empty' }, [el('h2', { text: 'Select a tenant' })]));
    render();
  }
  function paintFrame() {
    var st = drawerState;
    $('tenant-workspace').replaceChildren(
      el('div', { class: 'tenant-page-heading' }, [
        el('div', {}, [el('div', { class: 'tenant-title-line' }, [el('h2', { text: st.name || st.slug }), statusBadges(st)]), el('p', { class: 'muted', text: 'Tenant overview / ' + st.slug + (st.companyId ? ' · Company ID: ' + st.companyId : '') })]),
        el('a', { class: 'btn ghost', href: st.url, target: '_blank', rel: 'noopener', text: 'Open workspace' }),
      ]),
      el('nav', { class: 'tenant-tabs', 'aria-label': 'Tenant sections' }, ['overview', 'usage', 'health', 'subscription', 'billing', 'support', 'settings'].map(function (tab) {
        return el('button', { 'data-tab': tab, onclick: function () { selectTab(tab).catch(function (e) { toast(e.message); }); }, text: tab.charAt(0).toUpperCase() + tab.slice(1) });
      })),
      el('div', { id: 'tenant-content', 'aria-live': 'polite' })
    );
  }
  async function selectTab(tab) {
    activeTab = tab;
    document.querySelectorAll('[data-tab]').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'); });
    if (tab === 'settings') { paintDrawer(); return; }
    if (tab === 'subscription') { openSubscription(); return; }
    if (tab === 'billing') { window.ConsoleBilling.renderTenant(drawerState, $('tenant-content')); return; }
    $('tenant-content').replaceChildren(el('p', { class: 'muted', text: 'Loading analytics…' }));
    await openAnalytics(drawerState.slug);
  }

  function paintDrawer() {
    closeExisting();
    var st = drawerState;

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

    var owner = st.owner;
    var temporaryValue = el('input', { id: 'd-owner-temporary-value', readonly: 'readonly', autocomplete: 'off', class: 'hidden', 'aria-label': 'Temporary owner password' });
    var temporaryInfo = el('div', { id: 'd-owner-temporary-info', role: 'status', class: 'muted' });
    var fallback = el('button', {
      id: 'd-owner-temporary', type: 'button', class: 'btn ghost' + (st.isSandbox ? '' : ' hidden'), style: 'margin-top:8px',
      onclick: async function () {
        if (!confirm('Generate a temporary password for ' + owner.username + '? This replaces the current password and signs the owner out everywhere.')) return;
        var button = this; button.disabled = true;
        temporaryValue.value = ''; temporaryValue.classList.add('hidden'); temporaryInfo.textContent = '';
        try {
          var r = await api('POST', '/tenants/' + encodeURIComponent(st.slug) + '/reset-owner-password', { owner_id: owner.id, temporary: true, current_password: $('d-recovery-current').value, reason: $('d-recovery-reason').value });
          temporaryValue.value = r.temporary_password; temporaryValue.classList.remove('hidden');
          temporaryInfo.textContent = 'Share this password with the owner now. It expires in 24 hours and they must choose a new password at sign-in. It will disappear when you close this panel.';
          $('d-owner-err').textContent = 'Temporary password generated for ' + r.username + '.';
        } catch (ex) { $('d-owner-err').textContent = ex.message; }
        finally { button.disabled = false; }
      },
    }, ['Generate temporary password']);
    var recovery = el('form', { class: 'field', onsubmit: async function (e) {
      e.preventDefault();
      var password = $('d-owner-password');
      var again = $('d-owner-confirm');
      var err = $('d-owner-err');
      var btn = $('d-owner-reset');
      err.textContent = '';
      if (password.value !== again.value) { err.textContent = 'Passwords do not match.'; return; }
      btn.disabled = true;
      try {
        var result = await api('POST', '/tenants/' + encodeURIComponent(st.slug) + '/reset-owner-password', {
          owner_id: owner.id, new_password: password.value, current_password: $('d-recovery-current').value, reason: $('d-recovery-reason').value,
        });
        password.value = ''; again.value = ''; $('d-recovery-current').value = '';
        temporaryValue.value = ''; temporaryValue.classList.add('hidden'); temporaryInfo.textContent = '';
        err.textContent = 'Password reset for ' + owner.username + '. Share the new password with the owner.';
        if (!st.isSandbox && result.email) err.textContent += result.email.sent ? ' Notification email sent.' : ' Email not sent: ' + result.email.reason;
        fallback.classList.toggle('hidden', !st.isSandbox && (!result.email || result.email.sent));
        st.log = (await api('GET', '/tenants/' + encodeURIComponent(st.slug))).log || [];
      } catch (ex) { err.textContent = ex.message; }
      finally { btn.disabled = false; }
    } }, [
      el('label', { text: 'Owner login recovery' }),
      el('p', { class: 'muted', text: st.isSandbox ? 'Sandbox account: recovery emails are disabled.' : 'Regular account: recovery emails go to ' + (owner && owner.email || 'no address on file') + '.' }),
      el('p', { class: 'muted', text: owner ? 'First admin login: ' + owner.username + (owner.active ? '' : ' (inactive)') : 'No administrator account available.' }),
    ]);
    if (owner) {
      recovery.appendChild(el('label', { for: 'd-recovery-current', text: 'Your console password (fresh verification)' }));
      recovery.appendChild(el('input', { id: 'd-recovery-current', type: 'password', autocomplete: 'current-password' }));
      recovery.appendChild(el('label', { for: 'd-recovery-reason', text: 'Verified recovery reason (at least 20 characters)' }));
      recovery.appendChild(el('textarea', { id: 'd-recovery-reason' }));
      recovery.appendChild(el('label', { for: 'd-recovery-reference', text: 'Independent identity verification ticket/reference — no documents or secrets' }));
      recovery.appendChild(el('input', { id: 'd-recovery-reference' }));
      var approvals = el('div', { id: 'd-recovery-approvals', role: 'status' });
      async function refreshApprovals() {
        var list = await api('GET', '/tenants/' + encodeURIComponent(st.slug) + '/account-recoveries');
        approvals.textContent = '';
        list.forEach(function (request) {
          var row = el('p', { text: request.id + ' · ' + request.state + ' · requested by operator ' + request.requested_by });
          if (request.state === 'pending') row.appendChild(el('button', { type: 'button', class: 'btn ghost', text: 'Complete after 24-hour wait', onclick: async function () {
            this.disabled = true;
            try {
              var result = await api('POST', '/tenants/' + encodeURIComponent(st.slug) + '/account-recoveries/' + encodeURIComponent(request.id) + '/approve', { current_password: $('d-recovery-current').value, verification_reference: $('d-recovery-reference').value });
              toast(result.message); await refreshApprovals();
            } catch (ex) { toast(ex.message); }
            finally { $('d-recovery-current').value = ''; this.disabled = false; }
          } }));
          if (request.state === 'pending') row.appendChild(el('button', { type: 'button', class: 'btn ghost', text: 'Cancel request', onclick: async function () {
            try { await api('POST', '/tenants/' + encodeURIComponent(st.slug) + '/account-recoveries/' + encodeURIComponent(request.id) + '/cancel', { current_password: $('d-recovery-current').value }); await refreshApprovals(); }
            catch (ex) { toast(ex.message); } finally { $('d-recovery-current').value = ''; }
          } }));
          approvals.appendChild(row);
        });
      }
      recovery.appendChild(el('p', { class: 'muted', text: 'Lost authenticator: verify identity using established contacts, notify the existing owner email, then wait 24 hours. Verify again and confirm your console password before issuing a 15-minute recovery link. No second operator is needed. Password-only reset below does not remove MFA.' }));
      recovery.appendChild(el('button', { type: 'button', class: 'btn ghost', text: 'Request authenticator recovery', onclick: async function () {
        this.disabled = true;
        try {
          var result = await api('POST', '/tenants/' + encodeURIComponent(st.slug) + '/account-recoveries', { owner_id: owner.id, current_password: $('d-recovery-current').value, reason: $('d-recovery-reason').value, verification_reference: $('d-recovery-reference').value });
          toast(result.message); await refreshApprovals();
        } catch (ex) { toast(ex.message); }
        finally { $('d-recovery-current').value = ''; this.disabled = false; }
      } }));
      recovery.appendChild(el('button', { type: 'button', class: 'btn ghost', text: 'Refresh recovery approvals', onclick: function () { refreshApprovals().catch(function (ex) { toast(ex.message); }); } }));
      recovery.appendChild(approvals);
      recovery.appendChild(el('p', { class: 'muted', text: 'Set a new password when the owner cannot sign in. This signs them out everywhere and invalidates recovery links.' }));
      recovery.appendChild(el('label', { for: 'd-owner-password', text: 'New owner password' }));
      recovery.appendChild(el('input', { id: 'd-owner-password', type: 'password', minlength: '6', required: 'required', autocomplete: 'new-password' }));
      recovery.appendChild(el('label', { for: 'd-owner-confirm', text: 'Confirm password' }));
      recovery.appendChild(el('input', { id: 'd-owner-confirm', type: 'password', minlength: '6', required: 'required', autocomplete: 'new-password' }));
      recovery.appendChild(el('div', { id: 'd-owner-err', role: 'status', class: 'muted' }));
      recovery.appendChild(el('button', { id: 'd-owner-reset', type: 'submit', class: 'btn', style: 'margin-top:8px' }, ['Reset owner password']));
      recovery.appendChild(fallback);
      recovery.appendChild(temporaryValue);
      recovery.appendChild(temporaryInfo);
      if (!st.isSandbox) recovery.appendChild(el('button', {
        type: 'button', class: 'btn ghost', style: 'margin-top:8px',
        onclick: async function () {
          var button = this; button.disabled = true;
          try {
            var r = await api('POST', '/tenants/' + encodeURIComponent(st.slug) + '/recover-owner-username');
            $('d-owner-err').textContent = r.email.sent ? 'Owner username emailed.' : 'Email not sent: ' + r.email.reason;
            fallback.classList.toggle('hidden', r.email.sent);
          } catch (ex) { $('d-owner-err').textContent = ex.message; }
          finally { button.disabled = false; }
        },
      }, ['Email owner username']));
    }

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
        el('div', { class: 'field' }, [el('label', { text: 'Subscription' }), el('button', { class: 'btn ghost', onclick: function () { selectTab('subscription'); } }, ['Configure subscription'])]),
        el('div', { class: 'field' }, [el('label', { text: 'Status' }), statusSel]),
      ]),
      trialField,
      el('div', { class: 'field' }, [el('label', { text: 'Subscribed modules' }), el('div', { class: 'muted', text: st.useOverride ? withDeps(st.mods).join(', ') || 'None selected' : st.planDefault.join(', ') })]),
      el('div', { class: 'muted', text: 'Monthly PHP quote: ' + (st.subscription && st.subscription.monthly_total != null ? st.subscription.monthly_total.toFixed(2) : 'Unset') }),
      el('div', { class: 'muted', text: 'Login seat allowance: ' + (st.subscription && st.subscription.seat_limit != null ? st.subscription.seat_limit : 'Bundle default') }),
      el('div', { class: 'field' }, [el('label', { text: 'Current usage' }), usageBox, el('button', { class: 'btn ghost', style: 'margin-top:12px', onclick: function () { selectTab('overview').catch(function (e) { toast(e.message); }); } }, ['Analytics & support'])]),
      photoField,
      emailPanel(st.slug),
      recovery,
      logBox,
      el('div', { class: 'danger-zone' }, [
        el('h3', { text: 'Danger zone' }),
        el('div', { class: 'muted', text: st.isSandbox ? 'Remove this sandbox tenant and delete its database and uploaded files. Irreversible.' : 'Purge deletes this workspace’s database and uploaded files. Irreversible.' }),
        el('button', { class: 'btn danger', style: 'margin-top:8px', onclick: purge }, [st.isSandbox ? 'Remove sandbox tenant' : 'Purge workspace']),
      ]),
    ]);

    var drawer = el('div', { id: 'settings-panel', class: 'settings-panel' }, [
      body,
      el('div', { class: 'foot' }, [
        el('button', { class: 'btn', id: 'd-save', onclick: save }, ['Save changes']),
        el('button', { class: 'btn ghost', onclick: function () { selectTab('overview'); } }, ['Cancel']),
      ]),
    ]);
    $('tenant-content').replaceChildren(drawer);

    function syncTrialVisibility() {
      $('d-trial-field').classList.toggle('hidden', $('d-status').value !== 'trial' && $('d-status').value !== 'past_due');
    }
    statusSel.addEventListener('change', syncTrialVisibility);
    syncTrialVisibility();
  }

  function emailPanel(slug) {
    var panel = el('section', { class: 'field' }, [
      el('h3', { text: 'Tenant email / assisted setup' }),
      el('p', { class: 'muted', text: 'Configure the tenant’s own provider account. Agree any setup fee separately; saving here does not charge the tenant.' }),
      el('a', { href: '/_platform/email-setup.html', target: '_blank', rel: 'noopener', text: 'SMTP setup guide' }),
      el('button', { type: 'button', class: 'btn ghost', id: 'smtp-invoice', text: 'Invoice assisted SMTP setup', onclick: function () {
        if (window.ConsoleBilling) window.ConsoleBilling.newSetupInvoice(slug);
      } }),
      el('p', { class: 'muted', text: 'Use Billing to issue a one-time PHP implementation invoice and record payment. Track service completion separately in Support history.' }),
    ]);
    var status = el('p', { role: 'status', text: 'Loading email settings…' });
    panel.appendChild(status);
    var endpoint = '/tenants/' + encodeURIComponent(slug) + '/mail';
    api('GET', endpoint).then(function (s) {
      var controls = {};
      function field(key, label, type) {
        var input = el('input', { type: type || 'text', autocomplete: key === 'smtp_pass' ? 'new-password' : 'off' });
        if (type === 'checkbox') input.checked = !!s[key];
        else input.value = s[key] == null ? '' : String(s[key]);
        controls[key] = input;
        var id = 'smtp-' + key;
        input.id = id;
        panel.appendChild(el('div', { class: 'field' }, [el('label', { for: id, text: label }), input]));
      }
      var transport = el('select', { id: 'smtp-transport' }, [
        el('option', { value: 'off', text: 'Off' }), el('option', { value: 'smtp', text: 'SMTP' }),
      ]);
      transport.value = s.transport;
      panel.appendChild(el('div', { class: 'field' }, [el('label', { for: 'smtp-transport', text: 'Transport' }), transport]));
      field('from_name', 'From name');
      field('from_email', 'From email', 'email');
      field('reply_to', 'Reply-to', 'email');
      field('smtp_host', 'SMTP host');
      field('smtp_port', 'SMTP port (587 for STARTTLS; 465 for implicit TLS)', 'number');
      controls.smtp_port.min = '1'; controls.smtp_port.max = '65535';
      field('smtp_secure', 'Use implicit TLS (port 465 only)', 'checkbox');
      field('smtp_user', 'SMTP username');
      field('smtp_pass', s.has_password ? 'SMTP password / key (saved; leave blank to keep)' : 'SMTP password / key', 'password');
      var clear = el('input', { type: 'checkbox', id: 'smtp-clear' });
      panel.appendChild(el('label', { for: 'smtp-clear' }, [clear, ' Clear saved SMTP password']));
      field('test_to', 'Test recipient', 'email');
      status.textContent = s.ready ? 'Configured (delivery has not been verified in this session).' : 'Email is off or incomplete.';
      var saveBtn = el('button', { class: 'btn', type: 'button', text: 'Save email settings' });
      var testBtn = el('button', { class: 'btn ghost', type: 'button', text: 'Save & send test' });
      async function submit(test) {
        if (test && !controls.test_to.value.trim()) { status.textContent = 'Enter a test recipient.'; return; }
        if (test && !controls.test_to.reportValidity()) return;
        saveBtn.disabled = testBtn.disabled = true;
        status.textContent = test ? 'Saving and testing…' : 'Saving…';
        try {
          var body = { transport: transport.value };
          ['from_name', 'from_email', 'reply_to', 'smtp_host', 'smtp_user'].forEach(function (k) { body[k] = controls[k].value.trim(); });
          body.smtp_port = Number(controls.smtp_port.value);
          body.smtp_secure = controls.smtp_secure.checked;
          if (clear.checked) body.smtp_pass = '';
          else if (controls.smtp_pass.value) body.smtp_pass = controls.smtp_pass.value;
          await api('PUT', endpoint, body);
          if (body.smtp_pass !== undefined) s.has_password = !!body.smtp_pass;
          controls.smtp_pass.value = ''; clear.checked = false;
          controls.smtp_pass.placeholder = s.has_password ? 'Saved; leave blank to keep' : 'No password saved';
          panel.querySelector('label[for="smtp-smtp_pass"]').textContent = s.has_password ? 'SMTP password / key (saved; leave blank to keep)' : 'SMTP password / key';
          status.textContent = 'Email settings saved.';
          if (test) {
            await api('POST', endpoint + '/test', { to: controls.test_to.value.trim() });
            status.textContent = 'Test accepted by SMTP provider. Confirm it arrives in the recipient’s inbox or spam folder.';
          }
        } catch (ex) { status.textContent = ex.message; }
        finally { saveBtn.disabled = testBtn.disabled = false; }
      }
      saveBtn.addEventListener('click', function () { submit(false); });
      testBtn.addEventListener('click', function () { submit(true); });
      panel.appendChild(el('div', {}, [saveBtn, testBtn]));
    }).catch(function (ex) { status.textContent = ex.message; });
    return panel;
  }

  /* ---------- charts: local SVG, no external requests ---------- */
  function buildCharts(a) {
    var nf = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 1 });
    var value = function (v) { return v == null ? '—' : nf.format(v); };
    var seats = a.capacity.find(function (c) { return c.key === 'users'; });
    var wrap = el('div', { class: 'dashboard-visuals' });
    var cards = activeTab === 'overview' ? [
      ['Active users', a.engagement.active_30, 'Last 30 days'], ['Login seats', a.usage && a.usage.users, seats && seats.limit != null ? 'of ' + seats.limit + ' allocated' : 'Unlimited allowance'],
      ['Employee records', a.usage && a.usage.employees, 'Unlimited · no seat required'], ['Server errors', a.engagement.errors, 'Last 30 days'],
    ] : [
      ['Upload storage', a.storage && a.storage.uploads_mb, 'MB · includes nested uploads'], ['AI requests', a.usage && a.usage.ai_calls_month, 'Current calendar month'],
      ['Inventory items', a.usage && a.usage.inventory_items, 'Current item count'], ['Enabled modules', a.module_usage.length, 'Subscribed capabilities'],
    ];
    wrap.appendChild(el('div', { class: 'kpi-grid' }, cards.map(function (v) {
      return el('div', { class: 'kpi' }, [el('div', { class: 'kpi-label', text: v[0] }), el('div', { class: 'kpi-value', text: value(v[1]) }), el('div', { class: 'kpi-note', text: v[2] })]);
    })));
    var range = el('select', { 'aria-label': 'Chart date range' }, [7, 30, 90].map(function (n) { return el('option', { value: n, text: 'Last ' + n + ' days', selected: n === 30 ? 'selected' : null }); }));
    var plots = el('div', { class: 'chart-grid' });
    wrap.appendChild(el('div', { class: 'chart-heading' }, [el('strong', { text: activeTab === 'overview' ? 'Engagement overview' : 'Usage trends' }), range]));
    wrap.appendChild(plots);
    function svgNode(tag, attrs, text) {
      var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
      Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      if (text != null) n.textContent = text;
      return n;
    }
    function lineChart(title, description, rows, key, color) {
      var card = el('div', { class: 'chart-card' }, [el('h3', { text: title }), el('p', { text: description })]);
      var valid = rows.filter(function (r) { return r[key] != null && Number.isFinite(Number(r[key])); });
      if (!valid.length) { card.appendChild(el('div', { class: 'chart-empty', text: 'No recorded data in this range. Trends will appear as activity is collected.' })); return card; }
      var svg = svgNode('svg', { viewBox: '0 0 660 250', class: 'chart-svg', role: 'img', 'aria-label': title + ': ' + valid.length + ' recorded days' });
      var max = Math.max(1, Math.max.apply(null, valid.map(function (r) { return Number(r[key]); })) * 1.15);
      var minDate = Date.parse(valid[0].day), maxDate = Date.parse(valid[valid.length - 1].day);
      function x(r) { return maxDate === minDate ? 345 : 50 + (Date.parse(r.day) - minDate) / (maxDate - minDate) * 590; }
      function y(r) { return 205 - Number(r[key]) / max * 175; }
      for (var i = 0; i <= 4; i++) {
        var yy = 205 - i / 4 * 175;
        svg.appendChild(svgNode('line', { x1: 50, y1: yy, x2: 640, y2: yy, stroke: 'var(--line)', 'stroke-dasharray': '3 5' }));
        svg.appendChild(svgNode('text', { x: 40, y: yy + 4, 'text-anchor': 'end' }, nf.format(max * i / 4)));
      }
      var points = valid.map(function (r) { return x(r) + ',' + y(r); }).join(' ');
      if (valid.length > 1) {
        svg.appendChild(svgNode('polygon', { points: '50,205 ' + points + ' 640,205', fill: color, opacity: '.08' }));
        svg.appendChild(svgNode('polyline', { points: points, fill: 'none', stroke: color, 'stroke-width': 3, 'stroke-linejoin': 'round' }));
      }
      valid.forEach(function (r) {
        var dot = svgNode('circle', { cx: x(r), cy: y(r), r: 4, fill: color, tabindex: '0' });
        dot.appendChild(svgNode('title', {}, r.day + ': ' + nf.format(r[key]))); svg.appendChild(dot);
      });
      function dayLabel(day) { return new Date(day + 'T00:00:00Z').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
      svg.appendChild(svgNode('text', { x: 50, y: 235 }, dayLabel(valid[0].day)));
      svg.appendChild(svgNode('text', { x: 640, y: 235, 'text-anchor': 'end' }, dayLabel(valid[valid.length - 1].day)));
      card.appendChild(svg);
      card.appendChild(el('div', { class: 'chart-legend' }, [el('span', { style: '--series:' + color, text: title }), el('small', { text: valid.length === 1 ? 'One snapshot · more data needed for a trend' : 'Recorded days · UTC' })]));
      return card;
    }
    function draw() {
      plots.replaceChildren();
      var since = new Date(); since.setUTCDate(since.getUTCDate() - Number(range.value) + 1);
      var day = since.toISOString().slice(0, 10);
      if (activeTab === 'overview') {
        plots.appendChild(lineChart('Daily active users', 'Unique users with successful authenticated activity. Hover a point for its value.', a.daily_activity.filter(function (r) { return r.day >= day; }), 'active_users', 'var(--accent)'));
        var modules = el('div', { class: 'chart-card' }, [el('h3', { text: 'Module adoption' }), el('p', { text: 'Authenticated API requests · last 30 days' })]);
        var max = Math.max(1, Math.max.apply(null, a.module_usage.map(function (m) { return m.requests; })));
        a.module_usage.forEach(function (m) { modules.appendChild(el('div', { class: 'module-bar' }, [
          el('div', { class: 'bar-heading' }, [el('span', { text: m.module.charAt(0).toUpperCase() + m.module.slice(1) }), el('strong', { text: value(m.requests) })]),
          el('div', { class: 'bar-track', role: 'img', 'aria-label': m.module + ': ' + m.requests + ' requests' }, [el('div', { class: 'bar-fill', style: 'width:' + Math.max(0, m.requests / max * 100) + '%' })]),
        ])); });
        if (!a.module_usage.length) modules.appendChild(el('div', { class: 'chart-empty', text: 'No optional modules subscribed.' }));
        plots.appendChild(modules);
      } else {
        var rows = a.history.filter(function (r) { return r.day >= day; }).map(function (r) { return { day: r.day, storage_mb: r.usage.storage_mb, users: r.usage.users }; });
        plots.appendChild(lineChart('Upload storage (MB)', 'Verified usage snapshots, including nested folders.', rows, 'storage_mb', 'var(--accent)'));
        plots.appendChild(lineChart('Active login seats', 'Active accounts at each recorded snapshot.', rows, 'users', '#23a88a'));
      }
    }
    range.addEventListener('change', draw); draw();
    return wrap;
  }

  /* ---------- tenant analytics ---------- */
  async function openAnalytics(slug) {
    var tabAtRequest = activeTab, version = selectionVersion;
    var a = await api('GET', '/tenants/' + encodeURIComponent(slug) + '/analytics');
    if (!drawerState || drawerState.slug !== slug || version !== selectionVersion || activeTab !== tabAtRequest) return;
    var d = a.details;
    function textValue(v) {
      if (v == null) return 'Not available';
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !isNaN(Date.parse(v))) return new Date(v).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) + ' PHT';
      return String(v);
    }
    function section(title, kids) { return el('section', { class: 'analytics-section' }, [el('h3', { text: title })].concat(kids)); }
    function table(headers, rows) {
      return el('div', { class: 'analytics-table' }, [el('table', {}, [
        el('thead', {}, [el('tr', {}, headers.map(function (h) { return el('th', { text: h }); }))]),
        el('tbody', {}, rows.length ? rows.map(function (r) { return el('tr', {}, r.map(function (v) { return el('td', { text: textValue(v) }); })); }) : [el('tr', {}, [el('td', { colspan: headers.length, text: 'No recorded data yet.' })])]),
      ])]);
    }
    var inputs = {};
    function field(key, label, type) {
      var attrs = { type: type || 'text', value: d[key] == null ? '' : d[key] };
      if (type === 'number') { attrs.min = '0'; attrs.step = key === 'ai_cost_per_call_php' ? '0.0001' : '1'; }
      var input = key === 'notes' ? el('textarea', { rows: '4' }, [d[key] || '']) : el('input', attrs);
      inputs[key] = input;
      return el('div', { class: 'field' }, [el('label', { text: label }), input]);
    }
    var error = el('div', { class: 'err', role: 'alert' });
    var close = function () {};
    var usageRows = a.capacity.map(function (c) { return [c.key === 'users' ? 'Active login seats' : c.key, c.used, c.limit == null ? 'Unlimited' : c.limit, c.percent == null ? '—' : c.percent + '%']; });
    var historyRange = el('select', {}, [el('option', { value: '7', text: 'Last 7 snapshots' }), el('option', { value: '30', text: 'Last 30 snapshots', selected: 'selected' }), el('option', { value: '90', text: 'Last 90 snapshots' })]);
    var history = el('div');
    function renderHistory() {
      history.replaceChildren(table(['Day (UTC)', 'Login seats', 'Employees', 'Storage MB', 'Monthly AI calls'], a.history.slice(-Number(historyRange.value)).map(function (h) { return [h.day, h.usage.users, h.usage.employees, h.usage.storage_mb, h.usage.ai_calls_month]; })));
    }
    historyRange.addEventListener('change', renderHistory);
    renderHistory();
    var supportSubject = el('input', { placeholder: 'Support issue or follow-up', maxlength: '500' });
    var supportList = el('div');
    a.support.forEach(function (s) {
      var reply = el('textarea', { rows: '2', maxlength: '10000', placeholder: 'Reply to this ticket', 'aria-label': 'Reply to ticket ' + s.id });
      var status = el('select', { 'aria-label': 'Status for ticket ' + s.id }, ['open', 'in_progress', 'resolved'].map(function (v) { return el('option', { value: v, text: v.replace('_', ' ') }); }));
      status.value = s.status;
      var row = el('section', { class: 'support-entry' }, [
        el('h3', { text: '#' + s.id + ' · ' + s.subject }),
        el('p', { class: 'muted', text: (s.source === 'tenant' ? 'Tenant report' : 'Internal note') + ' · ' + (s.category || 'issue') + ' · ' + (s.priority || 'normal') + ' · ' + s.by + ' · ' + s.at }),
        el('p', { style: 'white-space:pre-wrap;overflow-wrap:anywhere', text: s.description || '' }), status,
      ]);
      status.addEventListener('change', async function () {
        try { await api('PATCH', '/tenants/' + encodeURIComponent(slug) + '/support/' + s.id, { status: status.value }); s.status = status.value; toast('Ticket status updated'); }
        catch (e) { status.value = s.status; error.textContent = e.message; }
      });
      (s.replies || []).forEach(function (r) {
        row.appendChild(el('div', { class: 'ticket-reply' }, [el('strong', { text: (r.source === 'owner' ? 'OTOM Support' : r.by) + ' · ' + r.at }), el('p', { style: 'white-space:pre-wrap;overflow-wrap:anywhere', text: r.body })]));
      });
      row.appendChild(reply);
      row.appendChild(el('button', { class: 'btn ghost', onclick: async function () {
        try { await api('POST', '/tenants/' + encodeURIComponent(slug) + '/support/' + s.id + '/replies', { body: reply.value }); await openAnalytics(slug); }
        catch (e) { error.textContent = e.message; }
      } }, ['Send reply']));
      supportList.appendChild(row);
    });
    var dashboard = el('div', { class: 'analytics-card' }, [
      el('div', { class: 'analytics-heading' }, [el('h2', { text: 'Tenant analytics — ' + slug }), el('button', { class: 'btn ghost', onclick: close }, ['Close'])]),
      el('p', { class: 'muted', text: 'Updated ' + textValue(a.generated_at) + '. Activity is measured from recorded authenticated API requests; it is not time spent in the app.' }),
      section('Support tickets', [el('p', { text: a.support.filter(function (t) { return t.status !== 'resolved'; }).length + ' unresolved · ' + a.support.filter(function (t) { return t.priority === 'urgent' && t.status !== 'resolved'; }).length + ' urgent' }), el('button', { class: 'btn ghost', onclick: function () { selectTab('support'); }, text: 'View tickets' })]),
      section('Alerts', a.alerts.length ? a.alerts.map(function (v) { return el('div', { class: 'analytics-alert', text: v.message }); }) : [el('p', { text: 'No current alerts.' })]),
      section('Usage & capacity', [table(['Resource', 'Used', 'Allowance', 'Used %'], usageRows), el('p', { text: 'Employee records: ' + textValue(a.usage && a.usage.employees) + ' · Unlimited allowance' })]),
      section('Engagement & onboarding', [table(['Metric', 'Value'], [
        ['Last activity', a.engagement.last_activity], ['Active users · 7 days', a.engagement.active_7], ['Active users · 30 days', a.engagement.active_30],
        ['Tracking since', a.tracking_started_at], ['Successful logins · 30 days', a.login_activity.successful], ['Failed logins · 30 days', a.login_activity.failed],
      ]), table(['Setup step', 'Status'], a.onboarding.map(function (v) { return [v.step, v.done ? 'Complete' : 'Pending']; }))]),
      section('Daily activity · retained 90 days', [table(['Day (UTC)', 'Active users', 'API requests', 'Server errors'], a.daily_activity.slice(-30).map(function (v) { return [v.day, v.active_users, v.requests, v.errors]; }))]),
      section('Module usage · 30 days', [table(['Subscribed module', 'API requests', 'Active users', 'Last used'], a.module_usage.map(function (v) { return [v.module, v.requests, v.active_users || 0, v.last_used]; })), el('p', { class: 'muted', text: 'These counts measure API activity. Module activation alone does not establish usage.' })]),
      section('Storage & AI costs', [table(['Metric', 'Value'], [
        ['Uploads MB', a.storage && a.storage.uploads_mb], ['Database MB (excludes WAL)', a.storage && a.storage.database_mb],
        ['Kiosk photos MB', a.storage && a.storage.kiosk_photos_mb], ['Storage growth MB/day', a.storage_growth.mb_per_day],
        ['Estimated days to storage limit', a.storage_growth.estimated_days_to_limit], ['Estimated AI cost PHP/month', a.ai_estimated_cost_php],
      ]), table(['Upload folder', 'MB'], a.storage ? a.storage.folders.map(function (f) { return [f.name, f.mb]; }) : []), el('p', { class: 'muted', text: 'AI cost uses your configured estimate per request; it is not a provider invoice. Growth requires at least two daily snapshots.' })]),
      section('Device sync & backup health', [table(['Device', 'Last heartbeat', 'Status'], a.sync.devices.map(function (v) { return [v.name, v.last_seen_at, v.stale ? 'Stale / never seen' : 'Recent heartbeat']; })), table(['Metric', 'Value'], [
        ['Server-visible pending sync commands', a.sync.pending], ['Undismissed sync conflicts / rejections', a.sync.conflicts],
        ['Latest local backup snapshot', a.backup.last_snapshot_at], ['Latest recorded backup attempt', a.backup.last_run_at],
        ['Backup attempt succeeded', a.backup.last_run_ok], ['Restore test verified', a.backup.restore_verified],
      ]), el('p', { class: 'muted', text: a.sync.device_local_queue_visibility + ' A recent heartbeat is not proof that all device data is synced. A backup file is not proof of a successful restore.' })]),
      section('Application performance', [table(['Metric', 'Value'], [
        ['API requests · 30 days', a.engagement.requests], ['Server errors · 30 days', a.engagement.errors],
        ['Mean response ms · 30 days', a.engagement.avg_ms], ['95th percentile response ms · 7 days', a.performance.p95_ms_7_days],
      ])]),
      section('Subscription & payments', [el('p', { text: 'Monthly quote PHP: ' + textValue(a.billing.monthly_quote_php) }), el('p', { class: 'muted', text: a.billing.note }), table(['Date', 'Subscription change'], a.subscription_history.map(function (v) { return [v.created_at, v.detail || v.action]; }))]),
      section('Usage history', [historyRange, history]),
      section('Customer details & alert thresholds', [
        field('contact_name', 'Customer contact'), field('contact_email', 'Contact email', 'email'), field('notes', 'Internal notes'),
        el('div', { class: 'row2' }, [field('warning_pct', 'Capacity warning %', 'number'), field('inactive_days', 'Inactive after days', 'number')]),
        el('div', { class: 'row2' }, [field('sync_stale_hours', 'Stale device after hours', 'number'), field('ai_cost_per_call_php', 'Estimated PHP cost per AI call (optional)', 'number')]),
        el('button', { class: 'btn', onclick: async function () {
          var patch = {};
          Object.keys(inputs).forEach(function (k) { patch[k] = inputs[k].type === 'number' ? inputs[k].value === '' && k === 'ai_cost_per_call_php' ? null : Number(inputs[k].value) : inputs[k].value; });
          try { await api('PUT', '/tenants/' + encodeURIComponent(slug) + '/owner-details', patch); close(); await openAnalytics(slug); toast('Customer details saved'); }
          catch (e) { error.textContent = e.message; }
        } }, ['Save details & thresholds']),
      ]),
      section('Support history', [supportSubject, el('button', { class: 'btn ghost', onclick: async function () {
        try { await api('POST', '/tenants/' + encodeURIComponent(slug) + '/support', { subject: supportSubject.value.trim(), status: 'open' }); close(); await openAnalytics(slug); }
        catch (e) { error.textContent = e.message; }
      } }, ['Add support issue']), supportList]),
      error,
      el('button', { class: 'btn ghost', onclick: async function () {
        try {
          var report = await api('GET', '/tenants/' + encodeURIComponent(slug) + '/analytics/export');
          var url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
          var link = el('a', { href: url, download: slug + '-analytics.json' }); document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        } catch (e) { error.textContent = e.message; }
      } }, ['Export tenant summary']),
    ]);
    var groups = { 'Support tickets': 'overview', 'Alerts': 'overview', 'Usage & capacity': 'usage', 'Engagement & onboarding': 'overview', 'Daily activity · retained 90 days': 'usage', 'Module usage · 30 days': 'usage', 'Storage & AI costs': 'usage', 'Device sync & backup health': 'health', 'Application performance': 'health', 'Subscription & payments': 'usage', 'Usage history': 'usage', 'Customer details & alert thresholds': 'support', 'Support history': 'support' };
    dashboard.querySelectorAll('.analytics-section').forEach(function (s) { s.classList.toggle('hidden', groups[s.querySelector('h3').textContent] !== activeTab); });
    if (activeTab === 'overview' || activeTab === 'usage') dashboard.prepend(buildCharts(a));
    $('tenant-content').replaceChildren(dashboard);
  }

  /* ---------- subscription editor ---------- */
  function openSubscription() {
    var st = drawerState;
    var sub = st.subscription || {
      mode: st.useOverride ? 'per_module' : 'bundle', bundle: st.plan,
      modules: withDeps(st.mods), seat_limit: null,
      bundle_price: null, module_prices: {}, seat_price: null,
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
    var seats = el('input', { type: 'number', min: '1', max: '1000000', step: '1',
      placeholder: 'Bundle default', value: sub.seat_limit == null ? '' : sub.seat_limit });
    var seatPrice = moneyInput(sub.seat_price);
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
    var modal = el('div', { class: 'subscription-view' }, [el('div', { class: 'card subscription-card' }, [
      el('h2', { text: 'Subscription — ' + st.name }),
      el('div', { class: 'field' }, [el('label', { text: 'Module selection' }), mode]),
      bundleFields, moduleRows,
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Maximum active login seats' }), seats]),
        el('div', { class: 'field' }, [el('label', { text: 'Price per login seat (PHP / month)' }), seatPrice]),
      ]),
      el('p', { class: 'muted', text: 'Blank seats = bundle account limit. Active login accounts use seats; employee records are unlimited.' }),
      el('p', { class: 'muted', text: 'Monthly quote = bundle or selected module prices + login seat allowance × seat price. Required module dependencies are included and priced separately. Blank prices are unset; enter 0 for free. These settings do not collect payments.' }),
      quote, err,
      el('div', { style: 'display:flex;gap:10px' }, [go, el('button', { class: 'btn ghost', onclick: function () { selectTab('overview'); } }, ['Cancel'])]),
    ])]);
    function amount(input) { return input.value.trim() === '' ? null : Number(input.value); }
    function value() {
      var prices = {};
      ref.modules.forEach(function (m) { prices[m] = amount(priceInputs[m]); });
      return { mode: mode.value, bundle: bundle.value, modules: withDeps(selected),
        seat_limit: amount(seats), bundle_price: amount(bundlePrice),
        module_prices: prices, seat_price: amount(seatPrice) };
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
      var seatTotal = v.seat_limit === null || v.seat_price === null ? null : v.seat_limit * Math.round(v.seat_price * 100) / 100;
      quote.textContent = moduleTotal === null || seatTotal === null ? 'Monthly quote: rates or login seat allowance unset' :
        'Monthly quote: ' + new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(moduleTotal + seatTotal) + ' / month';
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
    $('tenant-content').replaceChildren(modal);
    update();
  }

  function closeExisting() {
    $('tenant-content').replaceChildren();
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
      await load();
      await openDrawer(st.slug, 'settings');
    } catch (ex) { toast(ex.message); $('d-save').disabled = false; }
  }

  async function purge() {
    var st = drawerState;
    var typed = prompt('Type "' + st.slug + '" to permanently ' + (st.isSandbox ? 'remove this sandbox tenant:' : 'purge this workspace:'));
    if (typed == null) return;
    try {
      await api('POST', '/tenants/' + encodeURIComponent(st.slug) + '/purge', { confirm: typed });
      toast('Purged ' + st.slug);
      closeDrawer();
      await load();
    } catch (ex) { toast(ex.message); }
  }

  async function verifyConsolePasskey() {
    var challenge = await api('POST', '/passkeys/verify/options', {});
    var response = await ConsoleWebAuthn.startAuthentication({ optionsJSON: challenge.options });
    await api('POST', '/passkeys/verify', { token: challenge.token, response: response });
  }

  async function showPasskeySettings(forced) {
    if ($('passkeys-modal')) return;
    var card = el('div', { class: 'card account-security-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Console passkeys' }, [
      el('h2', { text: 'Console passkeys' }),
      el('p', { text: 'Use Windows Hello on this computer or a security key. Enroll a separate backup before relying on one device. Your PIN and biometric data stay with your authenticator.' }),
      el('div', { id: 'pk-list' }),
      el('div', { class: 'field' }, [el('label', { for: 'pk-password', text: 'Current password' }), el('input', { id: 'pk-password', type: 'password', autocomplete: 'current-password' })]),
      el('div', { class: 'field' }, [el('label', { for: 'pk-label', text: 'Passkey name' }), el('input', { id: 'pk-label', maxlength: '80', value: 'My Windows computer' })]),
      el('p', { class: 'err', id: 'pk-error', role: 'alert' }),
      el('button', { class: 'btn', id: 'pk-add' }, ['Add passkey']),
      el('button', { class: 'btn ghost', id: 'pk-require' }, ['Require passkeys for all operators']),
      el('button', { class: 'btn ghost', id: 'pk-close' }, [forced ? 'Sign out' : 'Close'])
    ]);
    var modal = el('div', { class: 'modal', id: 'passkeys-modal' }, [card]);
    document.body.appendChild(modal);
    var keys = [];
    async function refresh() {
      keys = (await api('GET', '/passkeys')).keys;
      $('pk-list').replaceChildren();
      keys.forEach(function (key) {
        var remove = el('button', { class: 'btn ghost', disabled: keys.length < 2 ? 'disabled' : null }, ['Remove']);
        remove.onclick = async function () {
          remove.disabled = true;
          try { await verifyConsolePasskey(); await api('POST', '/passkeys/remove', { id: key.id, current_password: $('pk-password').value }); $('pk-password').value = ''; await refresh(); }
          catch (error) { $('pk-error').textContent = error.message; remove.disabled = false; }
        };
        $('pk-list').appendChild(el('p', {}, [key.label + ' ', remove]));
      });
      $('pk-require').disabled = !keys.length;
    }
    $('pk-add').onclick = async function () {
      this.disabled = true; $('pk-error').textContent = '';
      try {
        if (keys.length) await verifyConsolePasskey();
        var challenge = await api('POST', '/passkeys/register/options', { current_password: $('pk-password').value });
        var response = await ConsoleWebAuthn.startRegistration({ optionsJSON: challenge.options });
        await api('POST', '/passkeys/register/verify', { token: challenge.token, response: response, label: $('pk-label').value.trim() });
        $('pk-password').value = '';
        if (forced) { modal.remove(); await boot(); } else { await refresh(); toast('Passkey added. Test your backup before removing another key.'); }
      } catch (error) { $('pk-error').textContent = error.message; }
      finally { if ($('pk-add')) $('pk-add').disabled = false; }
    };
    $('pk-require').onclick = async function () {
      this.disabled = true;
      try { await verifyConsolePasskey(); await api('POST', '/passkeys/require', {}); toast('All operators must enroll a passkey.'); }
      catch (error) { $('pk-error').textContent = error.message; }
      finally { this.disabled = false; }
    };
    $('pk-close').onclick = async function () { modal.remove(); if (forced) { await api('POST', '/logout'); showLogin(); } };
    try { await refresh(); } catch (error) { $('pk-error').textContent = error.message; }
    $('pk-password').focus();
  }

  /* ---------- change own password ---------- */
  $('password-btn').addEventListener('click', function () {
    var card = el('div', { class: 'card account-security-card' }, [
      el('h2', { text: 'Account & security' }),
      el('button', { class: 'btn', onclick: function () { modal.remove(); showPasskeySettings(false); } }, ['Manage passkeys']),
      el('h3', { text: 'Change username' }),
      el('p', { class: 'muted', id: 'un-current-label', text: 'Current username: ' + me.username }),
      el('div', { class: 'field' }, [el('label', { for: 'un-new', text: 'New username' }), el('input', { id: 'un-new', autocomplete: 'username', minlength: '3', maxlength: '30' })]),
      el('small', { class: 'muted', text: '3–30 letters, numbers, dots, underscores or hyphens. Other sessions will be signed out.' }),
      el('div', { class: 'field' }, [el('label', { for: 'un-cur', text: 'Current password' }), el('input', { id: 'un-cur', type: 'password', autocomplete: 'current-password' })]),
      el('div', { class: 'err', id: 'un-err', role: 'alert' }),
      el('button', { class: 'btn', id: 'un-go' }, ['Update username']),
      el('hr'),
      el('h3', { text: 'Change password' }),
      el('div', { class: 'field' }, [el('label', { for: 'pw-cur', text: 'Current password' }), el('input', { id: 'pw-cur', type: 'password', autocomplete: 'current-password' })]),
      el('div', { class: 'field' }, [el('label', { for: 'pw-new', text: 'New password' }), el('input', { id: 'pw-new', type: 'password', autocomplete: 'new-password' }),
        el('small', { class: 'muted', text: 'At least 15 characters, not a common password. Other signed-in browsers are signed out.' })]),
      el('div', { class: 'field' }, [el('label', { for: 'pw-again', text: 'New password again' }), el('input', { id: 'pw-again', type: 'password', autocomplete: 'new-password' })]),
      el('div', { class: 'err', id: 'pw-err', role: 'alert' }),
      el('div', { style: 'display:flex;gap:10px;margin-top:6px' }, [
        el('button', { class: 'btn', id: 'pw-go' }, ['Change password']),
        el('button', { class: 'btn ghost', id: 'pw-cancel' }, ['Cancel']),
      ]),
    ]);
    var modal = el('div', { class: 'modal', id: 'modal' }, [card]);
    document.body.appendChild(modal);
    $('un-go').onclick = async function () {
      if (this.disabled) return;
      var button = this;
      button.disabled = true;
      $('un-err').textContent = '';
      try {
        var result = await api('POST', '/username', { current_password: $('un-cur').value, new_username: $('un-new').value.trim() });
        me.username = result.username;
        $('un-current-label').textContent = 'Current username: ' + result.username;
        $('who').textContent = me.full_name || me.username;
        $('un-cur').value = ''; $('un-new').value = '';
        toast('Username updated. Use ' + result.username + ' next time you log in.');
      } catch (error) { $('un-err').textContent = error.message; }
      finally { button.disabled = false; }
    };
    $('un-new').focus();
    $('pw-cancel').addEventListener('click', function () { modal.remove(); });
    $('pw-go').addEventListener('click', async function () {
      $('pw-err').textContent = '';
      if ($('pw-new').value !== $('pw-again').value) { $('pw-err').textContent = 'The new passwords do not match.'; return; }
      $('pw-go').disabled = true;
      try {
        await api('POST', '/password', { current_password: $('pw-cur').value, new_password: $('pw-new').value });
        modal.remove();
        toast('Password changed');
      } catch (ex) { $('pw-err').textContent = ex.message; $('pw-go').disabled = false; }
    });
  });

  /* ---------- new tenant ---------- */
  // `prefill` (from a website inquiry, inquiries.js): { name, email, inquiry_id }.
  $('new-btn').addEventListener('click', function () { openNewTenant(); });
  function openNewTenant(prefill) {
    prefill = prefill || {};
    var card = el('div', { class: 'card' }, [
      el('h2', { text: 'New tenant' }),
      el('div', { class: 'field' }, [el('label', { text: 'Company name' }), el('input', { id: 'n-name', placeholder: 'Acme Mfg' }), el('small', { class: 'muted', id: 'n-url', text: 'Company name also determines the tenant URL.' })]),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Admin username' }), el('input', { id: 'n-user', placeholder: 'owner' })]),
        el('div', { class: 'field' }, [el('label', { text: 'Admin password' }), el('input', { id: 'n-pass', type: 'password' })]),
      ]),
      el('p', { class: 'muted', text: 'Choose modules, login seat allowance, and pricing after creating the tenant.' }),
      el('div', { class: 'field' }, [el('label', { for: 'n-sandbox' }, [
        el('input', { id: 'n-sandbox', type: 'checkbox', onchange: function () {
          $('n-email-field').classList.toggle('hidden', this.checked);
          $('n-email').required = !this.checked;
        } }), ' Sandbox account',
      ]), el('p', { class: 'muted', text: 'Sandbox accounts need only a company name and login details. Recovery emails are disabled.' })]),
      el('div', { class: 'field', id: 'n-email-field' }, [
        el('label', { for: 'n-email', text: 'Owner recovery email (required)' }),
        el('input', { id: 'n-email', type: 'email', required: 'required', autocomplete: 'email' }),
        el('p', { class: 'muted', text: 'Used to recover the owner username and password.' }),
      ]),
      el('div', { class: 'field' }, [el('label', { for: 'n-lock' }, [
        el('input', { id: 'n-lock', type: 'checkbox' }), ' Lock until first payment',
      ]), el('p', { class: 'muted', text: 'They can sign in and pay from Billing; everything else opens once you confirm their first payment.' })]),
      prefill.inquiry_id ? el('p', { class: 'muted', text: 'Linked to website inquiry #' + prefill.inquiry_id + '.' }) : null,
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
    if (prefill.name) { $('n-name').value = prefill.name; $('n-name').dispatchEvent(new Event('input')); }
    if (prefill.email) $('n-email').value = prefill.email;
    $('n-cancel').addEventListener('click', close);
    $('n-go').addEventListener('click', async function () {
      $('n-err').textContent = '';
      if (!$('n-sandbox').checked && (!$('n-email').value.trim() || !$('n-email').checkValidity())) {
        $('n-err').textContent = 'Enter a valid owner recovery email address.'; return;
      }
      $('n-go').disabled = true;
      try {
        var company = $('n-sandbox').checked ? { name: $('n-name').value.trim() } : companyIdentity('n-name');
        var created = await api('POST', '/tenants', {
          slug: company.slug,
          name: company.name,
          admin_username: $('n-user').value.trim(),
          admin_password: $('n-pass').value,
          is_sandbox: $('n-sandbox').checked,
          admin_email: $('n-sandbox').checked ? undefined : $('n-email').value.trim(),
          awaiting_payment: $('n-lock').checked || undefined,
          inquiry_id: prefill.inquiry_id || undefined,
        });
        close();
        await load();
        toast('Created ' + created.slug);
        await openDrawer(created.slug, 'subscription');
        return created;
      } catch (ex) { $('n-err').textContent = ex.message; $('n-go').disabled = false; }
    });
  }

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
        await openDrawer(created.slug, 'subscription');
      } catch (ex) { $('i-err').textContent = ex.message; $('i-go').disabled = false; $('i-go').textContent = 'Import'; }
    });
  });

  /* ---------- go ---------- */
  setToken(null);
  boot().catch(function () { showLogin(); });
})();
