/* Shared account-access UI: the permission catalog (labels, grouping, which screens each one
   opens), the permission picker, the per-account "Access" drawer and the role editor drawer.
   Used by account/role administrators and HR onboarding. Only users.permissions may edit
   permission grants; account support and HR receive a read-only grant catalog. The server
   enforces these boundaries independently of the controls.

   A role is a named bundle of permissions (src/shared/roles.ts). An account gets its role's
   bundle; the Access drawer then adds or removes single permissions for that one person. */
window.AccessEditor = (() => {
  // Role key -> label. Filled from the catalog (roles are workspace data, GET /roles); kept as one
  // live object because other screens read AccessEditor.ROLE_LABELS directly.
  const ROLE_LABELS = {};
  function roleLabel(key) { return ROLE_LABELS[key] || humanize(key); }

  // Grouping/labels are presentation only — the permission keys themselves come from the
  // catalog endpoint, so this list can't drift from the backend. Groups follow the work's own
  // order, with approvals and specialist duties kept alongside the work they control.
  // `where` names screens a permission opens that the desktop menu can't tell us (phone app,
  // buttons inside a screen); desktop menu entries are added from nav-config.js automatically.
  const PERMISSION_GROUPS = [
    { id: 'basics', label: 'Phone app & messaging', items: [
      {"key": "mobile.access", "label": "Use the phone app", "desc": "Sign in at /m — Home, Clock, Inbox, payslips, requests, schedule and Profile", "where": ["Phone: Home, Clock, Inbox, Profile"]},
      {"key": "messages.view", "label": "Read messages", "desc": "Read in-app chat", "where": ["Phone: Inbox"]},
      {"key": "messages.send", "label": "Send messages", "desc": "Send in-app messages to other staff"},
    ] },
    { id: 'inventory', label: 'Inventory & warehouse', items: [
      {"key": "inventory.view", "label": "See inventory", "desc": "Items, stock levels, movements, suppliers, locations"},
      {"key": "inventory.create", "label": "Add items", "desc": "Create new inventory items"},
      {"key": "inventory.edit", "label": "Edit items", "desc": "Change existing inventory items"},
      {"key": "inventory.delete", "label": "Delete items", "desc": "Remove inventory items"},
      {"key": "inventory.receive", "label": "Receive supplier stock", "desc": "Record and reverse supplier purchase receipts. Finished-goods inspection and receipt are separate.", "where": ["Phone: Receive PR"]},
      {"key": "inventory.transfer", "label": "Transfer stock", "desc": "Move existing stock between locations. Does not sell goods or correct totals."},
      {"key": "inventory.count", "label": "Submit physical counts", "desc": "Count stock and submit discrepancies for independent review."},
      {"key": "inventory.review_counts", "label": "Review physical counts", "desc": "Plan counts and approve another counter’s corrections."},
      {"key": "inventory.adjust", "label": "Correct stock", "desc": "Unrestricted stock corrections and damage. Receiving, transfers, counts, kits and quality checks are separate."},
      {"key": "inventory.costs", "label": "See and maintain inventory costs", "desc": "Read valuation and maintain unit, material, labor and overhead costs."},
      {"key": "inventory.configure", "label": "Inventory form setup", "desc": "Customize fields on the item form"},
      {"key": "inventory.mobile", "label": "Phone warehouse view", "desc": "Show the Warehouse phone segment and scan shortcut; each stock action still needs its own permission", "where": ["Phone: Warehouse segment, Scan"]},
    ] },
    { id: 'orders', label: 'Sales & releasing', items: [
      {"key": "orders.view", "label": "See orders", "desc": "Sale orders, customers and releasing"},
      {"key": "orders.create", "label": "Create orders", "desc": "Raise new sale orders"},
      {"key": "orders.edit", "label": "Edit orders", "desc": "Change customer and sale-order details. Approved order lines are locked; sales approval and release authorization are separate."},
      {"key": "orders.delete", "label": "Delete orders", "desc": "Remove sale orders"},
      {"key": "orders.approve", "label": "Approve sales", "desc": "Approve and change sales statuses; does not physically release stock."},
      {"key": "orders.authorize", "label": "Authorize sales releases", "desc": "Issue commercial release authorization; physical fulfillment is separate."},
      {"key": "orders.release", "label": "Release sale orders", "desc": "Scan or enter goods out against an approved sale order", "where": ["Phone: Release SOs"]},
      {"key": "orders.override_release", "label": "Approve release exceptions", "desc": "Review independently requested release exceptions with a recorded reason."},
      {"key": "orders.direct_sale", "label": "Direct physical sale", "desc": "Exceptional direct unit stock-out; also requires Release sale orders and respects the release policy."},
      {"key": "orders.configure", "label": "Configure release policy", "desc": "Change the company-wide release authorization requirement."},
    ] },
    { id: 'returns', label: 'Customer returns', items: [
      {"key": "returns.receive", "label": "Receive customer returns", "desc": "Record physical returns against release slips, without approving restock."},
      {"key": "returns.inspect", "label": "Inspect customer returns", "desc": "Approve restock or rejection and reinspect repaired goods."},
      {"key": "returns.dispose", "label": "Dispose of rejected returns", "desc": "Choose repair, salvage or disposal for rejected returns."},
    ] },
    { id: 'purchasing', label: 'Purchasing & purchase cash', items: [
      {"key": "purchasing.request", "label": "Submit purchase requests", "desc": "Request budgeted purchases and track your own request; no approval or stock movement"},
      {"key": "purchasing.view", "label": "See purchasing", "desc": "Purchase orders, goods receipts, vendor bills"},
      {"key": "purchasing.manage", "label": "Run purchasing", "desc": "Prepare supplier orders and vendor bills; approval and cash handling are separate."},
      {"key": "purchasing.approve_requests", "label": "Approve purchase requests", "desc": "Approve independent purchase-request budgets. Cash handoff and settlement are separate."},
      {"key": "purchasing.approve_bills", "label": "Approve vendor bills", "desc": "Approve a vendor bill prepared by someone else."},
      {"key": "purchasing.override_match", "label": "Override purchase matching", "desc": "Change matching tolerances and explicitly override bill mismatches."},
      {"key": "purchasing.issue_cash", "label": "Issue purchase cash", "desc": "Record actual cash handoff for an approved purchase request."},
      {"key": "purchasing.settle_requests", "label": "Settle purchase requests", "desc": "Review liquidation independently of the buyer and close requests."},
    ] },
    { id: 'production', label: 'Production & job orders', items: [
      {"key": "production.view", "label": "See production", "desc": "Job orders, QC, batches, schedule, teams, products & BOM — read only"},
      {"key": "production.plan", "label": "Plan job orders", "desc": "Create and schedule job orders and assign production recorders."},
      {"key": "production.approve", "label": "Approve job orders", "desc": "Sign off a draft job order so the warehouse can release its parts"},
      {"key": "production.kit_release", "label": "Release production kits", "desc": "Accept, pick and release approved job-order component kits."},
      {"key": "production.record", "label": "Record production", "desc": "Record output for job orders assigned to you or your crew. Recording across other teams requires a separate permission.", "where": ["Phone: Record output"]},
      {"key": "production.work_all", "label": "Record across production teams", "desc": "Allow a production recorder to work jobs outside their explicit or crew assignments."},
      {"key": "production.pause", "label": "Pause / resume job orders", "desc": "Hold a running job order and continue it later"},
      {"key": "production.manage", "label": "Manage the line", "desc": "Pause, resume and close job orders early — each with a reason"},
      {"key": "production.repairs", "label": "Parts requests", "desc": "Issue or decline parts a rework unit needs", "where": ["Phone: Repairs"]},
      {"key": "production.configure", "label": "Configure production", "desc": "Maintain product BOMs, production teams, batches and manufacturing setup."},
    ] },
    { id: 'quality', label: 'Quality & finished goods', items: [
      {"key": "production.inspect_qc", "label": "QC technical inspection", "desc": "Pass or fail units on the technical check. QC and QA can work independently; both must pass before finished goods enter stock.", "where": ["Phone: QC desk"]},
      {"key": "production.inspect_qa", "label": "QA appearance inspection", "desc": "Pass or fail units on the appearance check. QC and QA can work independently; both must pass before finished goods enter stock.", "where": ["Phone: QA desk"]},
      {"key": "production.qa_review", "label": "Decide QA holds", "desc": "Pass, rectify or fail a unit QA put on hold"},
      {"key": "production.receive", "label": "Products In", "desc": "Receive finished output into stock after both QC and QA have passed. Does not grant inspection authority.", "where": ["Phone: Products In"]},
      {"key": "qc.configure", "label": "Set up QC checklists", "desc": "Inspection checklists and criteria"},
    ] },
    { id: 'delivery', label: 'Deliveries', items: [
      {"key": "delivery.manage", "label": "Schedule deliveries", "desc": "Plan and manage deliveries"},
      {"key": "delivery.run", "label": "Run deliveries", "desc": "Mark deliveries picked up or completed", "where": ["Phone: Deliveries"]},
    ] },
    { id: 'hr', label: 'HR & employee records', items: [
      {"key": "hr.view", "label": "See HR records", "desc": "Employees, timekeeping, daily report, memos — not pay"},
      {"key": "hr.manage", "label": "Manage HR records", "desc": "Add and edit employees, cutoffs and timekeeping; approve requests", "where": ["Phone: Approvals"]},
      {"key": "reports.confidential", "label": "Handle anonymous reports", "desc": "Read, reply to and close anonymous-channel reports"},
    ] },
    { id: 'timekeeping', label: 'Timekeeping & attendance', items: [
      {"key": "hr.timekeeping.view", "label": "Read timekeeping", "desc": "Read attendance and a minimal employee roster without personnel or payroll records."},
      {"key": "hr.timekeeping.manage", "label": "Manage timekeeping", "desc": "Maintain attendance, shifts, rosters and cutoffs without personnel or pay access."},
      {"key": "hr.kiosk", "label": "Operate time clock kiosk", "desc": "Display the kiosk and capture attendance on an approved device without HR personnel access."},
    ] },
    { id: 'payroll', label: 'Payroll & pay rates', items: [
      {"key": "payroll.view", "label": "See pay", "desc": "Rates on the employee record, payslips, 13th month, final pay"},
      {"key": "payroll.manage", "label": "Prepare payroll", "desc": "Prepare, calculate and email payslips. Rates, policy, approval and payment are separate."},
      {"key": "payroll.rates", "label": "Maintain pay rates", "desc": "Change employee salary and rate histories."},
      {"key": "payroll.approve", "label": "Approve payroll posting", "desc": "Review independently prepared payroll and post it to the ledger."},
      {"key": "payroll.pay", "label": "Confirm payroll payment", "desc": "Mark or unmark payslips as paid. Cannot prepare amounts or change rates."},
      {"key": "payroll.configure", "label": "Configure payroll", "desc": "Maintain statutory tables, payroll policies and payroll form definitions."},
    ] },
    { id: 'accounting', label: 'Accounting & payments', items: [
      {"key": "accounting.view", "label": "See the books", "desc": "Ledger, AR/AP, tax filings, petty cash"},
      {"key": "accounting.manage", "label": "Prepare accounting entries", "desc": "Prepare accounting entries; posting, payments and configuration are separate."},
      {"key": "accounting.post", "label": "Post accounting entries", "desc": "Approve and post independently prepared journals or reverse posted entries."},
      {"key": "accounting.record_payments", "label": "Record financial payments", "desc": "Record and void customer receipts, supplier payments and petty-cash movements. Preparing and posting journals are separate."},
      {"key": "accounting.configure", "label": "Configure the books", "desc": "Maintain ledger setup, chart of accounts, periods and posting rules."},
    ] },
    { id: 'docs', label: 'Files, forms & evidence', items: [
      {"key": "forms.view", "label": "See files", "desc": "Uploaded files and documents"},
      {"key": "forms.upload", "label": "Upload files", "desc": "Add new files"},
      {"key": "forms.delete", "label": "Delete files", "desc": "Remove uploaded files"},
      {"key": "evidence.manage", "label": "Custody of evidence", "desc": "Read problem photos and remove other uploaders’ editable evidence within tasks you can access. Signed evidence stays locked."},
      {"key": "templates.view", "label": "See templates", "desc": "Document templates"},
      {"key": "templates.edit", "label": "Edit own templates", "desc": "Create and change personal templates"},
      {"key": "templates.company", "label": "Edit company templates", "desc": "Shared, company-wide templates"},
      {"key": "forms.fill.inventory", "label": "Enter Inventory forms", "desc": "Enter forms assigned to your role or account; view their records and edit/submit active drafts"},
      {"key": "forms.manage.inventory", "label": "Build inventory forms", "desc": "Form Builder for the Inventory section"},
      {"key": "forms.manage.hr", "label": "Build HR forms", "desc": "Form Builder for the HR section (memos, notices)"},
      {"key": "forms.manage.accounting", "label": "Build accounting forms", "desc": "Form Builder for the Accounting section"},
      {"key": "forms.manage.admin", "label": "Build admin forms", "desc": "Form Builder for the Admin section"},
      {"key": "forms.variables", "label": "Maintain shared form variables", "desc": "Change values shared across all form scopes."},
    ] },
    { id: 'comms', label: 'Announcements & email', items: [
      {"key": "announce", "label": "Post announcements", "desc": "Company-wide announcements", "where": ["Phone: Announcements"]},
      {"key": "mail.send", "label": "Send email", "desc": "External email through the company's mailbox"},
    ] },
    { id: 'admin', label: 'Accounts, security & workspace', items: [
      {"key": "users.manage", "label": "Support accounts", "desc": "Create and support ordinary staff accounts. Roles, grants, privileged accounts and workspace settings require separate permissions."},
      {"key": "users.permissions", "label": "Administer roles and permissions", "desc": "Create role bundles, assign roles and manage permission exceptions. Changes to privileged accounts also require sign-in security authority."},
      {"key": "security.manage", "label": "Administer sign-in security", "desc": "Manage MFA policy, kiosk enrollment and privileged-account recovery."},
      {"key": "workspace.manage", "label": "Administer the workspace", "desc": "Configure workspace integrations, installed PCs, billing and support."},
      {"key": "audit.view", "label": "Activity log", "desc": "The app-wide audit trail"},
    ] },
  ];

  function humanize(key) {
    const words = String(key || '').split('.').join(' ').replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  /** Desktop menu entries each permission opens, read from nav-config.js (window.NAV) so the
      hint follows the real menu: "Inventory › Customers", "HR" … */
  function desktopScreens() {
    const out = {};
    const add = (k, label) => { (out[k] = out[k] || []).includes(label) || out[k].push(label); };
    (window.NAV || []).forEach((p) => {
      if (p.requiredPermission) add(p.requiredPermission, p.label);
      (p.subtabs || []).forEach((s) => {
        if (s.requiredPermission && s.requiredPermission !== p.requiredPermission) add(s.requiredPermission, `${p.label} › ${s.label}`);
      });
    });
    return out;
  }

  let permCatalog = null;
  /** GET /users/permissions/catalog, plus `groups` (with "where" hints) and the role label map.
      `fresh` re-reads it — after a role was added or edited. */
  async function getCatalog(fresh) {
    if (permCatalog && !fresh) return permCatalog;
    permCatalog = await API.get('/users/permissions/catalog');
    for (const k of Object.keys(ROLE_LABELS)) delete ROLE_LABELS[k];
    (permCatalog.roles || []).forEach((r) => { ROLE_LABELS[r.key] = r.label; });
    const screens = desktopScreens();
    const known = new Set(PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key)));
    const extra = (permCatalog.permissions || []).filter((p) => !known.has(p));
    const groups = extra.length
      ? [...PERMISSION_GROUPS, { id: 'other', label: 'Other', items: extra.map((k) => ({ key: k, label: humanize(k), desc: `Permission key: ${k}` })) }]
      : PERMISSION_GROUPS;
    const live = new Set(permCatalog.permissions || []);
    permCatalog.groups = groups.map((g) => ({
      ...g,
      items: g.items.filter((i) => live.has(i.key)).map((i) => ({ ...i, where: [...(screens[i.key] || []), ...(i.where || [])] })),
    })).filter((g) => g.items.length);
    return permCatalog;
  }

  function roleOf(catalog, key) { return (catalog.roles || []).find((r) => r.key === key) || null; }

  /* ---------- Permission picker ----------
     renderPicker(container, {
       catalog,
       isOn(key) -> bool,
       change(key) -> 'added' | 'removed' | null   (account mode: difference from the role)
       lockReason(key) -> string | null            (shown instead of a usable switch)
       onToggle(key, on), onReset(key)?
     }) -> { refresh() }
     Search, an "On / Changed" filter, per-section "All / None" and live counts. */
  function renderPicker(container, o) {
    const ui = { q: '', show: 'all', group: '' };
    const showChanged = typeof o.change === 'function';
    container.innerHTML = `
      <div class="pp-toolbar">
        <div class="search-box pp-search">${UI.icon('search', 15)}<input type="search" data-pp-q aria-label="Find a permission or screen" placeholder="Find a permission or screen…" /></div>
        <div class="pp-seg" role="group" aria-label="Show">
          <button type="button" data-pp-show="all" class="on" aria-pressed="true">All</button>
          <button type="button" data-pp-show="on" aria-pressed="false">On</button>
          ${showChanged ? '<button type="button" data-pp-show="changed" aria-pressed="false">Changed</button>' : ''}
        </div>
      </div>
      <div class="pp-overview">
        <select data-pp-group aria-label="Filter permissions by work area">
          <option value="">All work areas</option>
          ${o.catalog.groups.map((g) => `<option value="${UI.esc(g.id)}">${UI.esc(g.label)}</option>`).join('')}
        </select>
        <div class="pp-summary" data-pp-summary role="status" aria-live="polite"></div>
      </div>
      <p class="pp-hint">Hover or tap a <b>?</b> for what each permission allows.</p>
      <div class="pp-list" data-pp-list role="region" aria-label="Permissions" tabindex="0"></div>`;
    const list = container.querySelector('[data-pp-list]');
    const summary = container.querySelector('[data-pp-summary]');

    function matches(i, g) {
      if (ui.group && ui.group !== g.id) return false;
      if (ui.show === 'on' && !o.isOn(i.key)) return false;
      if (ui.show === 'changed' && !(showChanged && o.change(i.key))) return false;
      if (!ui.q) return true;
      const hay = `${g.label} ${i.label} ${i.desc || ''} ${(i.where || []).join(' ')} ${i.key}`.toLowerCase();
      return ui.q.split(/\s+/).every((w) => hay.includes(w));
    }

    function row(i) {
      const on = o.isOn(i.key);
      const lock = o.lockReason ? o.lockReason(i.key) : null;
      const ch = showChanged ? o.change(i.key) : null;
      const explanation = [i.desc, i.where?.length ? `Screens: ${i.where.join('; ')}.` : '', lock].filter(Boolean).join(' ');
      return `
        <div class="pp-row${on ? ' is-on' : ''}${lock ? ' is-locked' : ''}${ch ? ' is-' + ch : ''}">
          <label class="pp-switch" ${lock ? `data-tip="${UI.esc(lock)}"` : ''}>
            <input type="checkbox" data-pp-key="${UI.esc(i.key)}" ${on ? 'checked' : ''} ${lock ? 'disabled' : ''} aria-label="${UI.esc(i.label)}" aria-description="${UI.esc(explanation)}" />
            <span class="pp-track"></span>
          </label>
          <div class="pp-text">
            <div class="pp-label" data-tip="${UI.esc(explanation)}">${UI.esc(i.label)}
              ${ch === 'added' ? '<span class="pp-tag added">Added for this person</span>' : ''}
              ${ch === 'removed' ? '<span class="pp-tag removed">Removed for this person</span>' : ''}
              ${lock ? `<span class="pp-tag locked">${UI.esc(lock)}</span>` : ''}
            </div>
          </div>
          ${UI.helpIcon(`${i.label}. ${explanation}`)}
          ${ch && o.onReset && !lock ? `<button type="button" class="pp-undo" data-pp-reset="${UI.esc(i.key)}" title="Back to the role's setting">Undo</button>` : ''}
        </div>`;
    }

    function refresh() {
      const focused = document.activeElement;
      const focusKey = list.contains(focused) ? ['ppKey', 'ppReset', 'ppBulk'].find((k) => focused.dataset[k]) : null;
      const focusValue = focusKey ? focused.dataset[focusKey] : null;
      const all = o.catalog.groups.flatMap((g) => g.items);
      const onCount = all.filter((i) => o.isOn(i.key)).length;
      const changes = showChanged ? all.filter((i) => o.change(i.key)) : [];
      const added = changes.filter((i) => o.change(i.key) === 'added').length;
      summary.innerHTML = `<b>${onCount}</b> of ${all.length} on`
        + (showChanged && changes.length ? ` · <span class="pp-added">${added} added</span> · <span class="pp-removed">${changes.length - added} removed</span> for this person` : '');

      let visibleCount = 0;
      const html = o.catalog.groups.map((g) => {
        const items = g.items.filter((i) => matches(i, g));
        visibleCount += items.length;
        if (!items.length) return '';
        const groupOn = g.items.filter((i) => o.isOn(i.key)).length;
        const editable = items.some((i) => !(o.lockReason && o.lockReason(i.key)));
        return `
          <section class="pp-group" data-pp-area="${UI.esc(g.id)}" aria-label="${UI.esc(g.label)}">
            <header class="pp-group-head">
              <span class="pp-group-label">${UI.esc(g.label)}</span>
              <span class="pp-count${groupOn ? ' some' : ''}">${groupOn}/${g.items.length} on</span>
              <span class="grow"></span>
              ${editable ? `<button type="button" class="pp-bulk" data-pp-bulk="${g.id}" data-on="1" aria-label="Enable shown permissions in ${UI.esc(g.label)}">Enable ${items.length === g.items.length ? 'all' : 'shown'}</button>
              <button type="button" class="pp-bulk" data-pp-bulk="${g.id}" data-on="0" aria-label="Disable shown permissions in ${UI.esc(g.label)}">Disable ${items.length === g.items.length ? 'all' : 'shown'}</button>` : ''}
            </header>
            ${items.map(row).join('')}
          </section>`;
      }).join('');
      list.innerHTML = html || UI.emptyState({ icon: 'search', title: 'Nothing matches', hint: ui.show === 'all' ? 'Try another word.' : 'Switch the filter back to All.' });
      if (ui.q || ui.group || ui.show !== 'all') summary.innerHTML += ` · ${visibleCount} shown`;
      if (focusKey) {
        const next = [...list.querySelectorAll('[data-pp-key], [data-pp-reset], [data-pp-bulk]')].find((x) => x.dataset[focusKey] === focusValue && (focusKey !== 'ppBulk' || x.dataset.on === focused.dataset.on));
        (next || list).focus({ preventScroll: true });
      }

      list.querySelectorAll('[data-pp-key]').forEach((cb) => {
        cb.onchange = () => { o.onToggle(cb.dataset.ppKey, cb.checked); refresh(); };
      });
      list.querySelectorAll('[data-pp-reset]').forEach((b) => {
        b.onclick = () => { o.onReset(b.dataset.ppReset); refresh(); };
      });
      list.querySelectorAll('[data-pp-bulk]').forEach((b) => {
        b.onclick = () => {
          const g = o.catalog.groups.find((x) => x.id === b.dataset.ppBulk);
          g.items.filter((i) => matches(i, g) && !(o.lockReason && o.lockReason(i.key)))
            .forEach((i) => o.onToggle(i.key, b.dataset.on === '1'));
          refresh();
        };
      });
    }

    container.querySelector('[data-pp-q]').addEventListener('input', (e) => { ui.q = e.target.value.trim().toLowerCase(); refresh(); });
    container.querySelector('[data-pp-group]').addEventListener('change', (e) => { ui.group = e.target.value; refresh(); list.scrollTop = 0; });
    container.querySelectorAll('[data-pp-show]').forEach((b) => {
      b.onclick = () => {
        ui.show = b.dataset.ppShow;
        container.querySelectorAll('[data-pp-show]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
        refresh();
      };
    });
    refresh();
    return { refresh };
  }

  /** Open the Access drawer for one account: its role's permissions, plus switches to add or
      remove single permissions for this person only. `u` needs id, full_name, role and
      permission_overrides (JSON string) — or pass an id and it's fetched from
      GET /users/:id/access. `onSaved(overridesJson)` runs after a successful save. */
  async function open(u, { onSaved } = {}) {
    if (typeof u !== 'object') u = await API.get(`/users/${u}/access`);
    const catalog = await getCatalog(true);
    const grantable = new Set(catalog.grantable || catalog.permissions);
    let overrides = {};
    try { overrides = JSON.parse(u.permission_overrides || '{}'); } catch { /* ignore */ }
    const role = roleOf(catalog, u.role);
    const fixedAdmin = !!(role && role.fixed);
    const roleSet = new Set(role ? role.permissions : []);
    const roleEditable = !fixedAdmin && (!catalog.assignableRoles || catalog.assignableRoles.includes(u.role));

    const isOn = (k) => fixedAdmin || (k in overrides ? overrides[k] === true : roleSet.has(k));
    const change = (k) => (fixedAdmin || !(k in overrides) ? null : overrides[k] ? 'added' : 'removed');
    const lockReason = (k) => {
      if (fixedAdmin) return 'Administrators always have this';
      if (!roleEditable || !grantable.has(k)) return 'Only an administrator can change this';
      return null;
    };

    const d = UI.drawer({
      title: `Access — ${u.full_name}`,
      icon: 'key',
      bodyHTML: `
        <div class="pp-rolecard pp-intro">
          <div><span class="muted">Role</span> <strong>${UI.esc(role ? role.label : roleLabel(u.role))}</strong>
            <span class="muted">· ${fixedAdmin ? 'every permission' : `${roleSet.size} permissions`}</span></div>
          <p class="muted">${fixedAdmin
            ? 'Administrators always have every permission.'
            : roleEditable
              ? 'Switches here change <b>this person only</b>. To change everyone with this role, edit the role under Admin › Roles.'
              : 'This account has a management role — only an administrator can change its access.'}</p>
        </div>
        <div data-picker></div>`,
      footHTML: `
        <button class="btn secondary" id="perm-reset" ${roleEditable ? '' : 'disabled'}>Match the role</button>
        <button class="btn" id="perm-save" ${roleEditable ? '' : 'disabled'}>Save access</button>`,
      onOpen: (el) => el.classList.add('drawer-wide', 'drawer-access'),
    });
    if (!d) return;
    const el = d.el;
    const picker = renderPicker(el.querySelector('[data-picker]'), {
      catalog, isOn, change, lockReason,
      onToggle: (k, on) => { if (on === roleSet.has(k)) delete overrides[k]; else overrides[k] = on; },
      onReset: (k) => { delete overrides[k]; },
    });
    el.querySelector('#perm-reset').onclick = () => {
      // Only drop overrides this caller may touch; locked ones stay as they are.
      for (const k of Object.keys(overrides)) if (grantable.has(k)) delete overrides[k];
      picker.refresh();
      UI.toast('Matches the role again (not saved yet)');
    };
    el.querySelector('#perm-save').onclick = async () => {
      try {
        await API.put(`/users/${u.id}/permissions`, { overrides });
      } catch (e) {
        UI.toast(e.message, 'error');
        return;
      }
      u.permission_overrides = JSON.stringify(overrides);
      if (onSaved) onSaved(u.permission_overrides);
      UI.toast('Access saved');
      d.close();
    };
  }

  /** Create or edit a role (users.permissions). `role` null = new role; `copyFrom` pre-fills a new
      role from an existing one. `onSaved(role)` runs after save. */
  async function editRole(role, { copyFrom, onSaved } = {}) {
    const catalog = await getCatalog(true);
    const isNew = !role;
    const src = role || copyFrom;
    // A brand-new role starts with the phone app and messaging, like every built-in one.
    const selected = new Set(src ? src.permissions : ['mobile.access', 'messages.view', 'messages.send']);
    const staff = new Set(catalog.staffPermissions || []);
    const name = isNew ? (copyFrom ? `${copyFrom.label} (copy)` : '') : role.label;

    const d = UI.drawer({
      title: isNew ? 'New role' : `Role — ${role.label}`,
      icon: 'users',
      bodyHTML: `
        <div class="pp-intro">
          <div><label>Role name *</label><input data-r="label" maxlength="60" value="${UI.esc(name)}" placeholder="e.g. Line Supervisor" /></div>
          <details class="pp-role-details">
            <summary>Role description</summary>
            <input data-r="description" aria-label="What this role is for" maxlength="200" value="${UI.esc(src ? src.description || '' : '')}" placeholder="One line people see when picking a role" />
          </details>
          <div class="pp-rolecard" data-r-note></div>
        </div>
        <div data-picker></div>`,
      footHTML: `
        <button class="btn secondary" data-cancel>Cancel</button>
        <button class="btn" id="role-save">${isNew ? 'Create role' : 'Save role'}</button>`,
      onOpen: (el) => el.classList.add('drawer-wide', 'drawer-access'),
    });
    if (!d) return;
    const el = d.el;
    el.querySelector('[data-cancel]').onclick = d.close;
    const note = el.querySelector('[data-r-note]');
    function paintNote() {
      const hrOk = [...selected].every((k) => staff.has(k));
      const people = role ? role.user_count : 0;
      note.innerHTML = `<p class="muted">${people
        ? `Saving updates access immediately for <b>${people}</b> account${people === 1 ? '' : 's'} using this role.`
        : 'Accounts assigned this role inherit these permissions.'}
        ${hrOk ? 'HR can assign it.' : 'Assignment requires role administration.'}</p>`;
    }
    paintNote();
    renderPicker(el.querySelector('[data-picker]'), {
      catalog,
      isOn: (k) => selected.has(k),
      onToggle: (k, on) => { if (on) selected.add(k); else selected.delete(k); paintNote(); },
    });
    el.querySelector('#role-save').onclick = async () => {
      const body = {
        label: el.querySelector('[data-r="label"]').value.trim(),
        description: el.querySelector('[data-r="description"]').value.trim(),
        permissions: [...selected],
      };
      if (!body.label) { UI.toast('Give the role a name', 'error'); return; }
      let saved;
      try {
        saved = isNew ? await API.post('/roles', body) : await API.put('/roles/' + encodeURIComponent(role.key), body);
      } catch (e) { UI.toast(e.message, 'error'); return; }
      await getCatalog(true);
      UI.toast(isNew ? 'Role created' : 'Role saved');
      d.close();
      if (onSaved) onSaved(saved);
    };
  }

  /** One-line summary of what a role covers, by section: "Phone app & basics (3) · Inventory (2)". */
  function roleSummary(catalog, key) {
    const r = roleOf(catalog, key);
    if (!r) return '';
    if (r.fixed) return 'Every permission';
    const set = new Set(r.permissions);
    const parts = catalog.groups.map((g) => {
      const n = g.items.filter((i) => set.has(i.key)).length;
      return n ? `${g.label} (${n})` : null;
    }).filter(Boolean);
    return parts.length ? parts.join(' · ') : 'No permissions yet';
  }

  return { ROLE_LABELS, roleLabel, open, editRole, getCatalog, renderPicker, roleSummary, PERMISSION_GROUPS };
})();
