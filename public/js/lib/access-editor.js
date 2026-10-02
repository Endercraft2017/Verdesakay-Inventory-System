/* Shared account-access editor: the role labels, permission catalog grouping and the
   "Customize permissions" drawer, used by Admin > Accounts (users.manage, edits everything)
   and HR > Employees (hr.manage, edits only what GET /users/permissions/catalog reports as
   grantable for staff-role accounts — the server enforces the same limit on save). */
window.AccessEditor = (() => {
  const ROLE_LABELS = {
    admin: 'Administrator',
    admin_staff: 'Admin Staff',
    accounting: 'Accounting',
    warehouse: 'Warehouse',
    releasing: 'Releasing',
    csr: 'Customer Service',
    hr: 'HR',
    marketing: 'Marketing',
    // Narrow, single-task shop-floor roles (mobile-first) — each holds only the one
    // production permission its person needs, not the broad Warehouse role's full
    // inventory.adjust. See src/shared/permissions.ts ROLE_DEFAULTS.
    parts_clerk: 'Parts Clerk (accepts repair parts requests)',
    production_lead: 'Production Lead (records units off the line)',
    production_manager: 'Production Manager (lead + pause / resume / close early + QA holds)',
    qc_inspector: 'QC Inspector (first-pass inspection)',
    qa_inspector: 'QA Inspector (final-pass inspection)',
    receiving_clerk: 'Products In Clerk (receives passed units)',
    releasing_clerk: 'Releasing Clerk (scans SOs out)',
  };

  // Grouping/labels are a frontend-only presentation concern. The actual permission keys and
  // per-role defaults are NOT duplicated here — they're fetched from GET /users/permissions/catalog
  // (backed by src/permissions.ts) so this view can never drift from the backend's role defaults
  // the way its old hand-copied ROLE_DEFAULTS did (it was missing the hr.view/hr.manage permissions
  // entirely, so admins couldn't grant/revoke them here even though HR accounts had them).
  //
  // Each entry carries an explicit label rather than deriving one from the key (e.g. stripping
  // the group prefix off "messages.send" and "mail.send" both land on "send" — indistinguishable
  // checkboxes with the same caption right next to each other).
  const PERMISSION_GROUPS = [
    { label: 'Inventory', items: [
      { key: 'inventory.view', label: 'View', desc: 'See inventory items and stock levels' },
      { key: 'inventory.create', label: 'Create', desc: 'Add new inventory items' },
      { key: 'inventory.edit', label: 'Edit', desc: 'Edit existing inventory items' },
      { key: 'inventory.delete', label: 'Delete', desc: 'Delete inventory items' },
      { key: 'inventory.adjust', label: 'Adjust stock', desc: 'Receive, consume, or correct stock quantities' },
      { key: 'inventory.configure', label: 'Configure', desc: 'Change inventory settings — units, categories, locations' },
      { key: 'inventory.mobile', label: 'Mobile app access', desc: 'Use the mobile warehouse app' },
    ] },
    { label: 'Quality Control', items: [
      { key: 'qc.configure', label: 'Configure QC checklists', desc: 'Set up QC checklists and inspection criteria' },
    ] },
    { label: 'Production', items: [
      { key: 'production.approve', label: 'Approve job orders', desc: 'Sign off a draft job order so the warehouse can release its parts' },
      { key: 'production.pause', label: 'Pause / resume job orders', desc: 'Hold a running job order (e.g. for a higher-priority one) and continue it later' },
      { key: 'production.manage', label: 'Manage the line', desc: 'Pause, resume and close job orders early — each with a recorded reason' },
      { key: 'production.repairs', label: 'Accept/reject parts requests', desc: 'Warehouse: issue or decline parts a rework unit needs' },
      { key: 'production.record', label: 'Record production', desc: 'Add finished units/batches off the line' },
      { key: 'production.inspect_qc', label: 'Inspect units (QC, first pass)', desc: 'Pass/fail units and batches on the first inspection pass, request repair parts' },
      { key: 'production.inspect_qa', label: 'Inspect units (QA, final pass)', desc: 'Pass/fail units and batches on the final inspection pass, request repair parts' },
      { key: 'production.qa_review', label: 'Decide QA holds', desc: 'Release a unit QA held for review: pass it, send it to rectification or fail it (QA inspectors can too)' },
      { key: 'production.receive', label: 'Products In', desc: 'Receive QC/QA-passed output into stock' },
    ] },
    { label: 'Orders', items: [
      { key: 'orders.view', label: 'View', desc: 'See sales and purchase orders' },
      { key: 'orders.create', label: 'Create', desc: 'Create new orders' },
      { key: 'orders.edit', label: 'Edit', desc: 'Edit existing orders' },
      { key: 'orders.delete', label: 'Delete', desc: 'Delete orders' },
      { key: 'orders.release', label: 'Release sale orders', desc: 'Scan/enter goods out against an approved sale order' },
    ] },
    { label: 'Files', items: [
      { key: 'forms.view', label: 'View', desc: 'See uploaded files and documents' },
      { key: 'forms.upload', label: 'Upload', desc: 'Upload new files' },
      { key: 'forms.delete', label: 'Delete', desc: 'Delete uploaded files' },
    ] },
    { label: 'Form Builder', items: [
      { key: 'forms.manage.hr', label: 'HR forms', desc: 'Build and edit HR form templates' },
      { key: 'forms.manage.inventory', label: 'Inventory forms', desc: 'Build and edit inventory form templates' },
      { key: 'forms.manage.admin', label: 'Admin forms', desc: 'Build and edit admin form templates' },
      { key: 'forms.manage.accounting', label: 'Accounting forms', desc: 'Build and edit accounting form templates' },
    ] },
    { label: 'Messages & Email', items: [
      { key: 'messages.view', label: 'View messages', desc: 'Read in-app messages' },
      { key: 'messages.send', label: 'Send messages', desc: 'Send in-app messages to other staff' },
      { key: 'mail.send', label: 'Send email (SMTP)', desc: "Send external email through the company's mailbox" },
    ] },
    { label: 'Templates', items: [
      { key: 'templates.view', label: 'View', desc: 'See document templates' },
      { key: 'templates.edit', label: 'Edit', desc: 'Edit document templates' },
      { key: 'templates.company', label: 'Company templates', desc: 'Edit shared, company-wide templates' },
    ] },
    { label: 'HR', items: [
      { key: 'hr.view', label: 'View', desc: 'See HR records — employees, timekeeping, payroll' },
      { key: 'hr.manage', label: 'Manage', desc: 'Manage HR records and run payroll' },
    ] },
    { label: 'Accounting', items: [
      { key: 'accounting.view', label: 'View', desc: 'See accounting records — AP/AR, tax filings' },
      { key: 'accounting.manage', label: 'Manage', desc: 'Manage accounting records and post transactions' },
    ] },
    { label: 'Admin', items: [
      { key: 'users.manage', label: 'Manage users & permissions', desc: 'Create/edit staff accounts and set their permissions' },
      { key: 'audit.view', label: 'View activity log', desc: 'View the app-wide activity/audit log' },
      { key: 'reports.confidential', label: 'Handle anonymous reports', desc: 'Read, reply to and close reports filed through the anonymous channel' },
    ] },
    { label: 'Announcements', items: [
      { key: 'announce', label: 'Post announcements', desc: 'Post company-wide announcements' },
    ] },
    { label: 'Deliveries', items: [
      { key: 'delivery.run', label: 'Run deliveries', desc: 'Mark deliveries as picked up or completed' },
      { key: 'delivery.manage', label: 'Manage deliveries', desc: 'Schedule and manage deliveries' },
    ] },
  ];

  // Fallback label/tooltip for a permission key with no explicit entry above (e.g. a newly
  // added backend permission this list hasn't been updated for yet) — never blank, never
  // collides with a sibling that happens to share its last segment.
  function humanizePermKey(key) {
    const words = key.split('.').join(' ').replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  let permCatalog = null;
  async function getCatalog() {
    if (permCatalog) return permCatalog;
    permCatalog = await API.get('/users/permissions/catalog');
    // Any backend permission key not covered by a group above still needs to be editable —
    // surface it under "Other" rather than silently dropping it from the UI.
    const known = new Set(PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key)));
    const extra = (permCatalog.permissions || []).filter((p) => !known.has(p));
    permCatalog.groups = extra.length
      ? [...PERMISSION_GROUPS, { label: 'Other', items: extra.map((k) => ({ key: k, label: humanizePermKey(k), desc: `Permission key: ${k}` })) }]
      : PERMISSION_GROUPS;
    return permCatalog;
  }

  /** Open the permissions drawer for an account. `u` needs id, full_name, role and
      permission_overrides (JSON string) — or pass just an id and it's fetched from
      GET /users/:id/access. `onSaved(overridesJson)` runs after a successful save. */
  async function open(u, { onSaved } = {}) {
    if (typeof u !== 'object') u = await API.get(`/users/${u}/access`);
    const catalog = await getCatalog();
    const grantable = new Set(catalog.grantable || catalog.permissions);
    const allPermissions = catalog.groups.flatMap((g) => g.items.map((i) => i.key));
    let overrides = {};
    try { overrides = JSON.parse(u.permission_overrides || '{}'); } catch { /* ignore */ }
    const roleDefaults = new Set(catalog.roleDefaults[u.role] || []);
    const roleEditable = !catalog.assignableRoles || catalog.assignableRoles.includes(u.role);

    function effectivePerms() {
      const result = new Set();
      for (const p of allPermissions) {
        const ov = overrides[p];
        if (ov === true) result.add(p);
        else if (ov === false) { /* revoked */ }
        else if (roleDefaults.has(p)) result.add(p);
      }
      return result;
    }

    function renderEditor(container) {
      const effective = effectivePerms();
      container.innerHTML = catalog.groups.map((g) => `
        <div class="perm-group">
          <div class="perm-group-label">${UI.esc(g.label)}</div>
          <div class="perm-group-items">
            ${g.items.map(({ key: k, label, desc }) => {
              const checked = effective.has(k);
              const isOverride = k in overrides;
              const locked = !roleEditable || !grantable.has(k);
              return `<label class="perm-chip${checked ? ' is-checked' : ''}${locked ? ' is-locked' : ''}" data-tip="${UI.esc(locked ? 'Only an administrator can change this' : (desc || label))}">
                <input type="checkbox" data-perm="${k}" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''} />
                <span>${UI.esc(label)}</span>${isOverride ? ` <span class="perm-override" data-tip="Overridden from role default">${UI.icon('star', 11)}</span>` : ''}
              </label>`;
            }).join('')}
          </div>
        </div>`).join('');

      container.querySelectorAll('[data-perm]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const key = cb.dataset.perm;
          const isDefault = roleDefaults.has(key);
          const checked = cb.checked;
          if (checked === isDefault) {
            delete overrides[key]; // back to default, no override needed
          } else {
            overrides[key] = checked;
          }
          renderEditor(container); // re-render to update ★ markers
        });
      });
    }

    const editorId = 'perm-editor-' + u.id;
    UI.drawer({
      title: `Permissions — ${u.full_name}`,
      bodyHTML: `
        <p class="muted" style="font-size:12px;margin-top:0">
          Role: <strong>${UI.esc(ROLE_LABELS[u.role] || u.role)}</strong> · ★ = overridden from role default
          ${roleEditable ? '' : '<br>This account has a management role — only an administrator can change its access.'}
        </p>
        <div id="${editorId}"></div>`,
      footHTML: `
        <button class="btn secondary" id="perm-reset" ${roleEditable ? '' : 'disabled'}>Reset to defaults</button>
        <button class="btn" id="perm-save" ${roleEditable ? '' : 'disabled'}>Save permissions</button>`,
      onOpen: (el) => {
        renderEditor(el.querySelector(`#${editorId}`));
        el.querySelector('#perm-reset').onclick = () => {
          // Only drop overrides this caller may touch; locked ones must stay as they are.
          for (const k of Object.keys(overrides)) if (grantable.has(k)) delete overrides[k];
          renderEditor(el.querySelector(`#${editorId}`));
          UI.toast('Reset to role defaults (not yet saved)');
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
          UI.toast('Permissions saved');
        };
      },
    });
  }

  return { ROLE_LABELS, open, getCatalog };
})();
